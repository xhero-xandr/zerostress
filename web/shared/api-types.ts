// The shapes of the site's HTTP API, on their own and with no imports, so that the server builds its answers from them
// and the browser client (spec 012) and the extension read them as types, without pulling either side into the other
// (the report itself is agent/report-types.ts, kept the same way). The server types what it sends with these
// (server/app.ts), so a field renamed on one side stops the type check on the other (review F).

export type Stage = 'queued' | 'starting' | 'opening' | 'analysing' | 'done' | 'failed';

/** GET /api/tasks/:id */
export interface TaskStatus {
  id: string;
  stage: Stage;
  /** our sentence for the stage (the server's text table) */
  label: string;
  /** index of the step in the tracker: 0..3 */
  at: number;
  position: number | null;
  /** the host of the submitted address (the submitter's text) */
  host: string;
  has_report: boolean;
  /** the agent waits for the owner's decision on a risky action; the run is live meanwhile */
  awaiting: boolean;
  checked_at: number;
  shots: { desktop: boolean; tablet: boolean; mobile: boolean };
}

/** an example under the address field; `deep` also ticks the deep-check box ("Let the agent explore the page") */
export interface Demo { label: string; url: string; deep?: true }

/** POST /api/tasks: the task and the owner's key (shown once, kept by the tab) */
export interface TaskStarted { id: string; key: string }
/** POST /api/email-checks: how many links will be opened, how many were left out */
export interface EmailCheckStarted extends TaskStarted { links: number; skipped: number }
/** POST /api/files: the file as the server holds it */
export interface FileCheckStarted extends TaskStarted { name: string; bytes: number; sha256: string }

/** what VirusTotal knows about one file, by its SHA-256 */
export interface FileVerdict {
  /** VirusTotal has seen this very file before */
  known: boolean;
  malicious: number;
  suspicious: number;
  total: number;
  /** VirusTotal's name for what it is ("trojan.agenttesla"), when the engines agree on one */
  label: string | null;
  /** when anyone first sent it there, ISO time */
  first_seen: string | null;
}

/** POST /api/file-hash */
export interface FileHashAnswer { virustotal: FileVerdict | null }

/** what is known about the domain an email came from (POST /api/sender: only the domain is sent) */
export interface SenderInfo {
  domain: string;
  age_days: number | null;
  created: string | null;
  /** the receiving servers are told what to do with mail that fails the checks: reject it, quarantine it, or nothing */
  dmarc: 'reject' | 'quarantine' | 'none' | null;
  spf: boolean;
  mx: boolean;
  /** the brand this domain belongs to, by its name (paypal.com), or null */
  brand: string | null;
  /** the brand this domain imitates (paypa1.com, paypal-secure.com), or null */
  lookalike: string | null;
  /** a free mailbox service: anyone can have an address there */
  freemail: boolean;
  /** why Spamhaus lists the domain, "clean", or null when not asked */
  spamhaus: string | null;
  /** how many antivirus engines on VirusTotal flag the domain, of how many; null when not asked */
  virustotal: { malicious: number; suspicious: number; total: number } | null;
}

/** POST /api/reports/:id/chat */
export interface ChatAnswer { text: string; source: 'model' | 'rules'; note: string | null }

/** one decision the agent waits for (GET /api/tasks/:id/pending, with the owner's key) */
export interface Pending { command_id: string; command_sha256: string; label: string }
export interface PendingList { pending: Pending[] }
