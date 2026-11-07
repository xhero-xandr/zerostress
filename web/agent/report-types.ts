// The shape of the public report (spec 008, step 6), on its own and with no imports, so the browser client (spec 012)
// can import it as a type without pulling the agent in. report.ts builds values of these types, so the compiler keeps
// the two sides in step. Which fields hold text that is not ours: UNTRUSTED in report.ts.

export type PublicVerdict = 'benign' | 'suspicious' | 'malicious' | 'unknown';
export type PublicMode = 'rules_only' | 'text' | 'vision';
/** what a form asks a person to type, in kinds of our own (fields.ts) */
export type PublicAsk = 'password' | 'card_number' | 'card_security' | 'card_expiry' | 'one_time_code' | 'id_number' | 'birth_date' | 'email' | 'phone' | 'address' | 'name';

export interface PublicFacts {
  final_host: string;
  page_title: string;
  chain: Array<{ via: string; host: string }>;
  forms: Array<{ action_host: string; cross_origin: boolean; has_password: boolean; asks: PublicAsk[] }>;
  tls: Array<{ host: string; issuer: string; valid_to: string }>;
  blocked_requests: number;
  third_party_hosts: number;
  requests_total: number;
  hosts: string[];
  links: Array<{ text: string; host: string; other_site: boolean; goes: 'nowhere' | 'same' | 'other' }>;
  servers: Array<{ ip: string; country: string | null; asn: number | null; org: string | null; hosts: string[]; requests: number }>;
  servers_total: number;
  domain: { name: string; created: string | null; age_days: number | null; registrar: string | null } | null;
  devices: Array<{
    device: 'mobile' | 'tablet';
    nav_error: string | null;
    final_host: string;
    title: string;
    forms: number;
    has_password: boolean;
    action_hosts: string[];
    differs: Array<'other_site' | 'password_only_here'>;
    image: boolean;
  }>;
  hidden_text: boolean;
  popups: number;
  dialogs: number;
  downloads: Array<{ filename: string; saved: boolean }>;
}

import type { LogEntry } from './agent-log.ts';

export interface PublicReport {
  /** what happened, step by step (agent-log.ts): our codes, numbers, tokens, the model's id, hosts */
  log: LogEntry[];
  /** Cloudflare's URL Scanner, asked afterwards about a page we could not read; its verdict may only raise ours */
  second_opinion: null | {
    source: 'found' | 'submitted';
    scan_id: string;
    scanned_at: string;
    final_host: string;
    status: number | null;
    title: string;
    title_withheld: boolean;
    malicious: boolean | null;
    screenshot: boolean;
  };
  schema: 1;
  run_id: string;
  url: string;
  verdict: PublicVerdict;
  confidence: number;
  status: { state: string; failure: string | null };
  /** how the verdict was reached */
  mode: PublicMode;
  mode_reason: string | null;
  mode_text: string | null;
  /** the page tried to address an automated reader (and nothing more is said about it) */
  injection_attempt: boolean;
  signals: Array<{ id: string; level: string; text: string }>;
  summary: string | null;
  reasons: Array<{ claim: string; evidence: string[] }>;
  facts: PublicFacts;
  steps: Array<{ action: string; status: string }>;
  /** actions waiting for a person; the details are for whoever may decide */
  pending_approval: number;
  artifacts: Array<{ name: string; mime: string }>;
}
