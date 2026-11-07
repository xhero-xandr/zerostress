// A public report whose every text from outside is hostile, like hostile() in web/server/test/app.test.ts.
import type { PublicReport } from '../../agent/report-types.ts';
import type { TaskStatus } from '../src/api.ts';

export const EVIL = '"><img src=x onerror=alert(1)><script>alert(1)</script>';

export function hostile(over: Partial<PublicReport> = {}, facts: Partial<PublicReport['facts']> = {}): PublicReport {
  return {
    schema: 1,
    run_id: '11111111-2222-4333-8444-555555555555',
    url: `https://example.com/${EVIL}`,
    verdict: 'malicious',
    confidence: 0.9,
    status: { state: 'done', failure: null },
    second_opinion: { source: 'found', scan_id: '11111111-2222-4333-8444-555555555555', scanned_at: '2026-11-04T12:08:00.000Z', final_host: `evil.example${EVIL}`, status: 200, title: `Title ${EVIL}`, title_withheld: false, malicious: true, screenshot: true },
    // a host of the wrong shape never passes the server; the page must hold even if one did
    log: [
      { t: 0, code: 'vm_booting', d: { slot: 0, vcpu: 2, mem_mib: 1024, image: '7e016b2b2375' } },
      { t: 900, code: 'page', d: { host: EVIL } },
      { t: 1500, code: 'model_answered', d: { ms: 1100, tokens: 2300, verdict: 'malicious', next: 'none', mode: 'vision' } },
    ],
    mode: 'text',
    mode_reason: null,
    mode_text: null,
    injection_attempt: false,
    injection_source: null,
    signals: [{ id: 'password_form_cross_origin', level: 'high', text: `Password goes to ${EVIL}` }],
    summary: `Summary ${EVIL}`,
    reasons: [{ claim: `Claim ${EVIL}`, evidence: [EVIL] }],
    facts: {
      final_host: `evil.example${EVIL}`,
      page_title: `Title ${EVIL}`,
      chain: [{ via: 'requested', host: 'a.example' }, { via: EVIL, host: `b.example${EVIL}` }],
      forms: [{ action_host: `c.example${EVIL}`, cross_origin: true, has_password: true, asks: ['password'] }],
      tls: [{ host: 'a.example', issuer: `CA ${EVIL}`, valid_to: `2030-01-01${EVIL}` }],
      blocked_requests: 1,
      third_party_hosts: 2,
      requests_total: 12,
      hosts: [`d.example${EVIL}`],
      links: [{ text: `Link ${EVIL}`, host: `e.example${EVIL}`, other_site: true, goes: 'other' }],
      servers: [{ ip: '93.184.216.34', country: 'US', asn: 15133, org: `Org ${EVIL}`, hosts: [`f.example${EVIL}`], requests: 12 }],
      servers_total: 1,
      domain: { name: `g.example${EVIL}`, created: '2026-11-01T00:00:00.000Z', age_days: 4, registrar: `Reg ${EVIL}` },
      devices: [{ device: 'mobile', nav_error: null, final_host: `h.example${EVIL}`, title: `Phone ${EVIL}`, forms: 1, has_password: true, action_hosts: [`i.example${EVIL}`], differs: ['password_only_here'], image: true }],
      hidden_text: true,
      popups: 1,
      dialogs: 1,
      downloads: [{ filename: `invoice${EVIL}.exe`, saved: false }],
      ...facts,
    },
    steps: [],
    pending_approval: 0,
    artifacts: [{ name: 'aaaaaaaaaaaaaaaa.png', mime: 'image/png' }],
    ...over,
  };
}

export const ID = '0123456789abcdef0123456789abcdef';

export function status(over: Partial<TaskStatus> = {}): TaskStatus {
  return { id: ID, stage: 'done', label: 'Done', at: 3, position: null, host: 'example.com', has_report: true, awaiting: false, checked_at: 1_793_990_000_000, shots: { desktop: true, tablet: false, mobile: false }, ...over };
}

/** A report whose verdict was not reached, with one signal saying why. */
export const unread = (id: string, text: string) =>
  hostile({ verdict: 'unknown', confidence: 0, mode: 'rules_only', summary: null, reasons: [], signals: [{ id, level: 'info', text }] });
