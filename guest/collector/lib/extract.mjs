import { LIMITS, cut, cutBytes } from './limits.mjs';

/**
 * Runs in an isolated world of the page (own JavaScript globals, same DOM), so a page that redefines
 * Array.prototype, querySelectorAll or form.action cannot change what is reported. It must stay self-contained:
 * it is sent to the browser as source text.
 */
function pageProbe(limits) {
  const out = { title: '', lang: '', text: '', hidden: [], meta: [], comments: 0, forms: [], loosePasswords: 0, origin: '' };
  const doc = document;
  out.origin = location.origin;
  out.title = doc.title || '';
  out.lang = doc.documentElement ? doc.documentElement.getAttribute('lang') || '' : '';
  out.text = doc.body ? doc.body.innerText || '' : '';

  for (const m of doc.querySelectorAll('meta')) {
    if (out.meta.length >= limits.metaItems) break;
    const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
    const content = m.getAttribute('content');
    if (name && content != null) out.meta.push({ name: name.slice(0, 100), content: content.slice(0, limits.metaChars) });
  }

  const cw = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  while (cw.nextNode()) out.comments += 1;

  const parseColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const backgroundOf = (el) => {
    for (let n = el, i = 0; n && i < 30; n = n.parentElement, i++) {
      const bg = parseColor(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  if (doc.body) {
    const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
    const range = doc.createRange();
    let visited = 0;
    let bytes = 0;
    while (tw.nextNode() && visited < 20000) {
      visited += 1;
      const node = tw.currentNode;
      const txt = (node.nodeValue || '').trim();
      const el = node.parentElement;
      if (!txt || !el || skip.has(el.tagName)) continue;
      const reasons = [];
      const cs = getComputedStyle(el);
      if (el.getClientRects().length === 0) {
        reasons.push('not_rendered');
      } else {
        if (cs.visibility !== 'visible') reasons.push('visibility');
        if (parseFloat(cs.fontSize) < 1) reasons.push('zero_size');
        for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++) {
          if (parseFloat(getComputedStyle(n).opacity) === 0) { reasons.push('transparent'); break; }
        }
        const fg = parseColor(cs.color);
        const bg = backgroundOf(el);
        if (fg && fg.a > 0.5) {
          const a = lum(fg), b = lum(bg);
          if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.1) reasons.push('low_contrast');
        }
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) reasons.push('clipped');
        else if (r.right < 0 || r.bottom < 0 || r.left > doc.documentElement.scrollWidth + 50 || r.left < -1000) reasons.push('offscreen');
      }
      if (reasons.length && bytes < limits.hiddenTextBytes * 2) {
        out.hidden.push({ reasons, text: txt.slice(0, 500) });
        bytes += txt.length;
      }
    }
  }

  const forms = Array.from(doc.querySelectorAll('form'));
  const resolve = (v) => { try { return new URL(v == null || v === '' ? location.href : v, doc.baseURI); } catch { return null; } };
  forms.slice(0, limits.forms).forEach((f, i) => {
    const action = resolve(f.getAttribute('action'));
    const fields = [];
    const controls = f.querySelectorAll('input, select, textarea, button');
    controls.forEach((c, j) => {
      if (fields.length >= limits.fieldsPerForm) return;
      const tag = c.tagName.toLowerCase();
      const type = tag === 'input' ? (c.getAttribute('type') || 'text').toLowerCase() : tag === 'button' ? (c.getAttribute('type') || 'submit').toLowerCase() : tag;
      if (type === 'hidden' && !c.getAttribute('name')) return;
      const label = (c.labels && c.labels[0] ? c.labels[0].innerText : '') || c.getAttribute('aria-label') || c.getAttribute('placeholder') || '';
      fields.push({
        idx: i + '.' + j,
        tag, type,
        name: (c.getAttribute('name') || '').slice(0, 100),
        label: label.slice(0, 100),
        autocomplete: (c.getAttribute('autocomplete') || '').slice(0, 40),
        visible: c.getClientRects().length > 0 && getComputedStyle(c).visibility === 'visible',
        password: type === 'password',
      });
    });
    out.forms.push({
      form: i,
      action: action ? action.href : '',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      action_origin: action ? action.origin : '',
      origin_differs: action ? action.origin !== location.origin : false,
      has_password: fields.some((x) => x.password),
      fields,
    });
  });
  out.formsTotal = forms.length;
  out.loosePasswords = Array.from(doc.querySelectorAll('input[type=password]')).filter((p) => !p.form).length;
  return out;
}

const PROBE_SOURCE = `(${pageProbe.toString()})`;

/** Evaluates the probe in a fresh isolated world of the main frame through the given CDP session. */
export async function probePage(cdp, frameId) {
  const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'zerostress-probe', grantUniveralAccess: false });
  const res = await cdp.send('Runtime.evaluate', {
    expression: `${PROBE_SOURCE}(${JSON.stringify({
      metaItems: LIMITS.metaItems, metaChars: LIMITS.metaChars, hiddenTextBytes: LIMITS.hiddenTextBytes,
      forms: LIMITS.forms, fieldsPerForm: LIMITS.fieldsPerForm,
    })})`,
    contextId: world.executionContextId,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error('probe failed: ' + cut(res.exceptionDetails.text ?? '', 100));
  return res.result.value;
}

/** Turns the raw probe result into the `page`, `forms` evidence payloads with the limits applied. */
export function shapeProbe(raw, url) {
  const hiddenJoined = cutBytes(raw.hidden.map((h) => h.text).join(' | '), LIMITS.hiddenTextBytes);
  const reasons = [...new Set(raw.hidden.flatMap((h) => h.reasons))].sort();
  return {
    page: {
      url: cut(url, LIMITS.urlChars),
      title: cut(raw.title, 300),
      lang: cut(raw.lang, 35),
      text: cutBytes(raw.text, LIMITS.textBytes),
      text_truncated: Buffer.byteLength(raw.text) > LIMITS.textBytes,
      hidden_text: { present: raw.hidden.length > 0, reasons, text: hiddenJoined },
      meta: raw.meta,
      comments_count: raw.comments,
    },
    forms: { forms: raw.forms, total: raw.formsTotal, loose_password_fields: raw.loosePasswords },
  };
}
