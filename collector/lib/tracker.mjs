import { LIMITS, cut } from './limits.mjs';

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

/**
 * Everything the network and the navigation machinery report, read from ONE CDP session so the order of the events is
 * deterministic (CLAUDE.md). The page cannot influence this layer: it sees the browser, not the page's JavaScript.
 */
export async function attachTracker({ page, context, cdp, emitter }) {
  const { emit } = emitter;
  const requests = new Map(); // requestId -> in-flight request
  const tlsSeen = new Set();
  const stats = { requests: 0, requestsDropped: 0, blocked: 0, console: 0, consoleDropped: 0, popups: 0, popupsClosed: 0, dialogs: 0, downloads: 0 };
  let current = '';
  let mainFrameId = '';
  let scheduled = null; // navigation the page asked for and that has not happened yet
  const popupPages = new Set();

  const done = (entry, extra) => {
    if (entry.reported) return;
    entry.reported = true;
    stats.requests += 1;
    if (entry.blocked) stats.blocked += 1;
    if (stats.requests > LIMITS.requests) {
      stats.requestsDropped += 1;
      return;
    }
    emit('request', {
      url: cut(entry.url, LIMITS.urlChars), method: entry.method, resource_type: entry.type,
      status: entry.status ?? null, mime: entry.mime ?? null, blocked: entry.blocked ?? null,
      initiator: cut(entry.initiator, LIMITS.urlChars), ...extra,
    });
  };

  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.redirectResponse) {
      const prev = requests.get(e.requestId);
      if (prev) {
        prev.status = e.redirectResponse.status;
        prev.mime = e.redirectResponse.mimeType;
        done(prev);
      }
      if (e.type === 'Document' && e.frameId === mainFrameId) {
        emit('nav', {
          via: 'http', from: cut(e.redirectResponse.url, LIMITS.urlChars), to: cut(e.request.url, LIMITS.urlChars),
          status: e.redirectResponse.status, origin_changed: originOf(e.redirectResponse.url) !== originOf(e.request.url),
        });
      }
    }
    const init = e.initiator ?? {};
    const prevBlocked = requests.get(e.requestId)?.blocked;
    requests.set(e.requestId, {
      url: e.request.url, method: e.request.method, type: (e.type ?? 'Other').toLowerCase(),
      initiator: init.url || init.type || '', blocked: e.redirectResponse ? null : prevBlocked, reported: false,
    });
  });

  cdp.on('Network.responseReceived', (e) => {
    const entry = requests.get(e.requestId);
    if (entry) {
      entry.status = e.response.status;
      entry.mime = e.response.mimeType;
    }
    const sec = e.response.securityDetails;
    if (sec) {
      const host = originOf(e.response.url);
      if (!tlsSeen.has(host) && tlsSeen.size < LIMITS.tlsHosts) {
        tlsSeen.add(host);
        emit('tls', {
          host: cut(host, 300), issuer: cut(sec.issuer, 300), subject: cut(sec.subjectName, 300),
          valid_from: new Date(sec.validFrom * 1000).toISOString(), valid_to: new Date(sec.validTo * 1000).toISOString(),
          san_count: (sec.sanList ?? []).length, protocol: cut(sec.protocol, 40),
        });
      }
    }
  });

  cdp.on('Network.loadingFinished', (e) => {
    const entry = requests.get(e.requestId);
    if (entry) done(entry);
  });

  cdp.on('Network.loadingFailed', (e) => {
    const entry = requests.get(e.requestId);
    if (!entry) return;
    entry.blocked ??= e.blockedReason ?? (e.canceled ? 'canceled' : cut(e.errorText ?? 'failed', 60));
    done(entry);
  });

  cdp.on('Page.frameScheduledNavigation', (e) => {
    if (e.frameId !== mainFrameId) return;
    scheduled = { until: Date.now() + Math.min(e.delay, 10) * 1000 + 1500 };
    emit('nav', { via: 'scheduled', from: cut(current, LIMITS.urlChars), to: cut(e.url, LIMITS.urlChars), reason: e.reason, delay_s: e.delay });
  });
  cdp.on('Page.frameClearedScheduledNavigation', (e) => {
    if (e.frameId === mainFrameId) scheduled = null;
  });
  cdp.on('Page.frameNavigated', (e) => {
    if (e.frame.parentId) return;
    mainFrameId = e.frame.id;
    scheduled = null;
    emit('nav', { via: 'commit', from: cut(current, LIMITS.urlChars), to: cut(e.frame.url, LIMITS.urlChars), origin_changed: current !== '' && originOf(current) !== originOf(e.frame.url) });
    current = e.frame.url;
  });
  cdp.on('Page.navigatedWithinDocument', (e) => {
    if (e.frameId !== mainFrameId) return;
    emit('nav', { via: 'commit', same_document: true, from: cut(current, LIMITS.urlChars), to: cut(e.url, LIMITS.urlChars), origin_changed: false });
    current = e.url;
  });
  cdp.on('Page.javascriptDialogOpening', (e) => {
    stats.dialogs += 1;
    emit('dialog', { type: e.type, message: cut(e.message, LIMITS.dialogChars) });
  });

  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  const tree = await cdp.send('Page.getFrameTree');
  mainFrameId = tree.frameTree.frame.id;
  current = tree.frameTree.frame.url === 'about:blank' ? '' : tree.frameTree.frame.url;

  page.on('console', (m) => {
    if (stats.console >= LIMITS.consoleLines) {
      stats.consoleDropped += 1;
      return;
    }
    stats.console += 1;
    emit('console', { level: m.type(), text: cut(m.text(), LIMITS.consoleChars) });
  });
  page.on('download', (d) => {
    stats.downloads += 1;
    emit('download', { url: cut(d.url(), LIMITS.urlChars), filename: cut(d.suggestedFilename(), 255), mime: null, saved: false });
  });
  context.on('page', (p) => {
    if (p === page) return;
    stats.popups += 1;
    emit('popup', { url: cut(p.url(), LIMITS.urlChars) });
    if (popupPages.size >= LIMITS.popups) {
      stats.popupsClosed += 1;
      p.close().catch(() => {});
    } else {
      popupPages.add(p);
      p.on('close', () => popupPages.delete(p));
    }
  });

  return {
    stats,
    mainFrameId: () => mainFrameId,
    currentUrl: () => current,
    /** Waits for a client-side navigation the page has scheduled (meta refresh, timers), at most ~12 s. */
    async waitForScheduled() {
      while (scheduled && Date.now() < scheduled.until) await new Promise((r) => setTimeout(r, 100));
    },
    /** Reports requests that never finished, then the overflow counter. Call once, before the summary. */
    finish() {
      for (const entry of requests.values()) done(entry);
    },
  };
}
