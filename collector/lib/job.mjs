import { LIMITS } from './limits.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class JobError extends Error {}

/** Validates the first stdin line (spec 005, section 5). Throws JobError with a short reason. */
export function parseJob(line) {
  let job;
  try {
    job = JSON.parse(line);
  } catch {
    throw new JobError('job is not valid JSON');
  }
  if (job === null || typeof job !== 'object' || Array.isArray(job)) throw new JobError('job must be an object');
  if (job.schema !== 1) throw new JobError('unsupported schema');
  if (typeof job.run_id !== 'string' || !UUID.test(job.run_id)) throw new JobError('run_id must be a UUID');
  if (job.kind !== 'url') throw new JobError('unsupported kind');
  if (typeof job.url !== 'string' || job.url.length === 0 || job.url.length > LIMITS.urlChars) throw new JobError('bad url');
  let u;
  try {
    u = new URL(job.url);
  } catch {
    throw new JobError('bad url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new JobError('only http and https are allowed');

  let session = null;
  if (job.session !== undefined) {
    const s = job.session;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new JobError('session must be an object');
    const max = s.max_s ?? LIMITS.sessionMaxDefaultS;
    if (!Number.isInteger(max) || max < 1 || max > LIMITS.sessionMaxCapS) throw new JobError('bad session.max_s');
    session = { maxS: max };
  }
  let navTimeoutS = LIMITS.navTimeoutDefaultS;
  if (job.nav_timeout_s !== undefined) {
    if (!Number.isInteger(job.nav_timeout_s) || job.nav_timeout_s < 1 || job.nav_timeout_s > LIMITS.navTimeoutMaxS) {
      throw new JobError('bad nav_timeout_s');
    }
    navTimeoutS = job.nav_timeout_s;
  }
  return { runId: job.run_id, url: u.href, session, navTimeoutS };
}
