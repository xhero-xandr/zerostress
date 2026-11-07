// The side panel is a thin frame around https://zerostress.space/panel, the agent itself (spec 013): the panel only
// passes on the link a person chose with a right-click. Messages go to that origin only, and the frame's "ready" is
// taken only from that origin.
import { SERVICE, webLink } from './link.ts';

const SITE = new URL(SERVICE).origin;
const frame = document.getElementById('agent') as HTMLIFrameElement;
let ready = false;
const queue: string[] = [];

function hand(link: string) {
  const ok = webLink(link);
  if (!ok) return;
  if (ready) frame.contentWindow?.postMessage({ type: 'zs-check', link: ok }, SITE);
  else queue.push(ok);
}

window.addEventListener('message', (e) => {
  if (e.origin !== SITE || e.source !== frame.contentWindow) return;
  if ((e.data as { type?: unknown })?.type !== 'zs-ready') return;
  ready = true;
  for (const link of queue.splice(0)) hand(link);
});

chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: unknown; link?: unknown };
  if (m?.type === 'zs-check' && typeof m.link === 'string') { void chrome.storage.session.remove('handoff'); hand(m.link); }
});
void chrome.storage.session.get('handoff').then((v) => {
  const h = v.handoff as { link?: unknown; at?: unknown } | undefined;
  if (h && typeof h.link === 'string' && typeof h.at === 'number' && Date.now() - h.at < 60_000) {
    void chrome.storage.session.remove('handoff');
    hand(h.link);
  }
});
