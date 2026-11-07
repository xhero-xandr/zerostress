// The agent in the browser's side panel: a conversation about one link. The person gives a link (or picks one with a
// right-click); the agent starts a check on ZeroStress, tells what happens in the microVM as it happens (the agent log),
// stops and asks before any risky action (Allow / Don't allow), gives the verdict, and then answers questions about it.
// Everything that came from a page or from the model is put in as text, never as markup.
import type { LogEntry } from '../../agent/agent-log.ts';
import type { PublicReport } from '../../agent/report-types.ts';
import { asLogEntry, logLine, logTime, verdictLine } from '../../client/src/logic.ts';
import { T } from '../../client/src/text.ts';
import { ApiError, askSecondOpinion, chat, decide, eventsUrl, getPending, getReport, reportPage, startTask, type Pending } from './api.ts';
import { webLink } from './link.ts';

const S = {
  hello: 'Give me a link you do not trust. I open it in a disposable microVM on ZeroStress, never on this device, tell you what I see, and ask you before I do anything risky. You can also right-click any link and choose “Check this link in a sandbox”.',
  notALink: 'That is not a web address I can check (it has to start with http or https).',
  starting: 'On it. A fresh microVM is starting for this link only.',
  working: 'What I am doing:',
  needYou: 'I need your decision before I go on:',
  allow: 'Allow', deny: 'Don’t allow',
  allowed: 'Allowed. I am carrying it out, inside the sandbox only.',
  denied: 'Not allowed. I will not do it.',
  verdictLead: 'Verdict:',
  openReport: 'Open the full report',
  askSecond: 'Ask Cloudflare’s scanner',
  secondConsent: 'Nobody has scanned this exact link at Cloudflare recently. A new scan there is public: anyone can find the link. Publish it?',
  publish: 'Yes, publish and scan', dontPublish: 'No',
  secondDone: 'Cloudflare’s scanner answered: the full report now has its view and screenshot.',
  askPlaceholder: 'Ask about this result, or paste another link…',
  linkPlaceholder: 'Paste a link to check…',
  thinking: 'Thinking…',
  lost: 'I lost the connection to the check. The full report will still be there:',
};

const chatEl = document.getElementById('chat')!;
const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('input') as HTMLInputElement;
const send = document.getElementById('send') as HTMLButtonElement;
const deepBox = document.getElementById('deep') as HTMLInputElement;

let current: { id: string; key: string; report: PublicReport | null; es: EventSource | null } | null = null;
let busy = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function bubble(who: 'you' | 'agent', text = ''): HTMLDivElement {
  const b = el('div', `msg ${who}`, text);
  chatEl.append(b);
  b.scrollIntoView({ block: 'end' });
  return b;
}
function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const say = (text: string) => bubble('agent', text);
const message = (e: unknown) => (e instanceof ApiError ? e.message : T.serverError);

function mode(m: 'link' | 'ask') {
  input.placeholder = m === 'link' ? S.linkPlaceholder : S.askPlaceholder;
  send.textContent = m === 'link' ? 'Check' : 'Send';
}

async function check(link: string) {
  if (busy) return;
  const target = webLink(link);
  bubble('you', `Check ${link}`);
  if (!target) { say(S.notALink); return; }
  current?.es?.close();
  busy = true;
  try {
    const { id, key } = await startTask(target, deepBox.checked);
    current = { id, key, report: null, es: null };
    say(S.starting);
    follow(id, key);
  } catch (e) {
    say(message(e));
    busy = false;
  }
}

function follow(id: string, key: string) {
  const box = say(S.working);
  const list = el('ul', 'steps');
  box.append(list);
  const es = new EventSource(eventsUrl(id));
  current!.es = es;
  es.addEventListener('log', (ev) => {
    let entry: LogEntry | null = null;
    try { entry = asLogEntry(JSON.parse((ev as MessageEvent<string>).data)); } catch { /* not ours */ }
    if (!entry) return;
    const li = el('li');
    li.append(el('time', '', logTime(entry.t)), el('span', '', logLine(entry)));
    list.append(li);
    li.scrollIntoView({ block: 'end' });
  });
  es.addEventListener('approval', (ev) => {
    let waiting = false;
    try { waiting = (JSON.parse((ev as MessageEvent<string>).data) as { waiting?: unknown }).waiting === true; } catch { /* not ours */ }
    if (waiting) void askOwner(id, key);
  });
  es.addEventListener('final', () => { es.close(); void finish(id, key); });
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return;
    const b = say(S.lost);
    b.append(el('div', 'actions'));
    b.lastElementChild!.append(button(S.openReport, () => void chrome.tabs.create({ url: reportPage(id, key) })));
    busy = false;
  };
}

const asked = new Set<string>();
async function askOwner(id: string, key: string) {
  let pending: Pending[] = [];
  try { pending = (await getPending(id, key)).pending; } catch (e) { say(message(e)); return; }
  for (const p of pending) {
    if (asked.has(p.command_id)) continue;
    asked.add(p.command_id);
    const b = say(S.needYou);
    b.classList.add('approval');
    b.append(el('div', 'verdict', p.label));
    const row = el('div', 'actions');
    const go = async (allow: boolean) => {
      for (const x of row.querySelectorAll('button')) x.disabled = true;
      try { await decide(id, key, p, allow); say(allow ? S.allowed : S.denied); } catch (e) { say(message(e)); }
    };
    row.append(button(S.allow, () => void go(true)), button(S.deny, () => void go(false), 'danger'));
    b.append(row);
  }
}

async function finish(id: string, key: string) {
  let r: PublicReport;
  try { r = await getReport(id); } catch (e) { say(message(e)); busy = false; return; }
  if (current?.id === id) current.report = r;
  const b = say('');
  b.append(el('div', `verdict ${r.verdict}`, `${S.verdictLead} ${T.verdict[r.verdict]}`), el('div', '', verdictLine(r)));
  const serious = r.signals.filter((s) => s.level === 'high' || s.level === 'medium').slice(0, 4);
  if (serious.length) {
    const ul = el('ul', 'signals');
    for (const s of serious) ul.append(el('li', '', s.text));
    b.append(ul);
  }
  const row = el('div', 'actions');
  row.append(button(S.openReport, () => void chrome.tabs.create({ url: reportPage(id, key) }), 'secondary'));
  if (r.verdict === 'unknown' && !r.second_opinion) row.append(button(S.askSecond, () => void second(id, key, false)));
  b.append(row);
  busy = false;
  mode('ask');
  // the agent explains its verdict in plain words, from the report only (the same assistant as "Explain" on the site)
  await answer(id, { kind: 'explain' });
}

async function second(id: string, key: string, publish: boolean) {
  const wait = say(T.second.asking);
  try {
    await askSecondOpinion(id, key, publish);
    wait.textContent = S.secondDone;
    await finish(id, key);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'needs_consent') {
      wait.textContent = S.secondConsent;
      const row = el('div', 'actions');
      row.append(button(S.publish, () => { row.remove(); void second(id, key, true); }), button(S.dontPublish, () => row.remove(), 'secondary'));
      wait.append(row);
    } else wait.textContent = message(e);
  }
}

async function answer(id: string, payload: { kind: 'explain' } | { kind: 'ask'; message: string }) {
  const b = say(S.thinking);
  try {
    const a = await chat(id, payload);
    b.textContent = a.text;
    if (a.note) b.append(el('div', 'note', a.note));
  } catch (e) {
    b.textContent = message(e);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  // a link starts a new check; anything else is a question about the last result
  if (webLink(text) || !current?.report) { void check(text); return; }
  bubble('you', text);
  void answer(current.id, { kind: 'ask', message: text.slice(0, 300) });
});

// a link chosen with a right-click: given while the panel is open, or left in session storage when it was just opened
chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: unknown; link?: unknown };
  if (m?.type === 'zs-check' && typeof m.link === 'string') { void chrome.storage.session.remove('handoff'); void check(m.link); }
});
say(S.hello);
mode('link');
void chrome.storage.session.get('handoff').then((v) => {
  const h = v.handoff as { link?: unknown; at?: unknown } | undefined;
  if (h && typeof h.link === 'string' && typeof h.at === 'number' && Date.now() - h.at < 60_000) {
    void chrome.storage.session.remove('handoff');
    void check(h.link);
  }
});
