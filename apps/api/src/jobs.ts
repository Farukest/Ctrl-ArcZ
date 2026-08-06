import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bridge transfers, tracked so a client can leave and come back.
 *
 * A bridge is not a request. It is approve, burn, attestation and mint, roughly
 * thirty seconds of work that this process performs itself with the relayer's key.
 * Answering only at the end forced every client to hold a socket open for the
 * duration, lock its button, and lose the outcome entirely if the user changed tab.
 * The transfer carried on regardless -- nothing here aborts on client disconnect --
 * so the money was never at risk, but the user's knowledge of it was.
 *
 * WHY THE FILE. The steps in memory are a convenience. The transaction hashes are
 * not. CCTP burns USDC on the source chain and mints it on the destination against
 * a Circle attestation, and those are two separate transactions with a gap between
 * them. A process restart inside that gap leaves the money burned and unminted. It
 * is recoverable -- the attestation is permanent and `BridgeKit.retry` will finish
 * the job -- but only for someone holding the burn hash. Lose it and recovery starts
 * with a manual explorer search of the relayer's history.
 *
 * So hashes are appended to disk the moment a step reports one, before the transfer
 * is anywhere near finished. Circle's own guidance says the same thing: "save the
 * bridge transfer state for recovery scenarios."
 *
 * WHAT THIS IS NOT. It is not a queue and not a database. Jobs run in this process;
 * a restart still kills whatever was in flight. The file exists to make that
 * survivable, not to prevent it.
 */

export type JobState = 'running' | 'success' | 'failed';

export interface JobStep {
  name: string;
  state: 'running' | 'success' | 'error';
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export interface Job {
  jobId: string;
  engine: 'cctp' | 'gateway';
  from: string;
  to: string;
  amount: string;
  /** The address that authorised this, for quota accounting and support questions. */
  caller: string;
  state: JobState;
  steps: JobStep[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const STORE = process.env.JOB_STORE ?? join(process.cwd(), '.bridge-jobs.json');
const MAX_JOBS = 500;

const jobs = new Map<string, Job>();

/** Load whatever a previous process wrote, so a restart can still answer for it. */
function hydrate(): void {
  try {
    if (!existsSync(STORE)) return;
    const rows = JSON.parse(readFileSync(STORE, 'utf8')) as Job[];
    for (const job of rows) {
      // A job this process did not start cannot still be running: the work died
      // with the process that owned it. Saying "running" would promise progress
      // nobody is making. `failed` would be a lie of the opposite kind, because the
      // burn may well have landed, so it is reported as interrupted with its hashes
      // intact and left for recovery.
      if (job.state === 'running') {
        job.state = 'failed';
        job.error =
          'The server restarted while this transfer was in flight. Any completed step is recorded below; a burn without a mint can still be finished from its transaction hash.';
        job.finishedAt = Date.now();
      }
      jobs.set(job.jobId, job);
    }
  } catch {
    // A corrupt or unreadable store must not stop the API from serving. The cost is
    // losing recovery hashes, which is why the write below is atomic.
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    // Newest first, capped: this is a recovery aid, not an archive.
    const rows = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_JOBS);
    const tmp = `${STORE}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows));
    renameSync(tmp, STORE); // atomic: a crash mid-write cannot truncate the store
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('failed to persist bridge jobs:', e instanceof Error ? e.message : e);
  }
}

hydrate();

export function createJob(
  init: Pick<Job, 'engine' | 'from' | 'to' | 'amount' | 'caller'>,
): Job {
  const job: Job = {
    jobId: randomBytes(16).toString('hex'),
    ...init,
    state: 'running',
    steps: [],
    startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  persist();
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

/**
 * Record a step. Persists only when the step carries a transaction hash, because
 * that is the part worth surviving a restart; progress alone is not worth an fsync
 * every few seconds.
 */
export function recordStep(jobId: string, step: JobStep): void {
  const job = jobs.get(jobId);
  if (!job) return;
  const existing = job.steps.findIndex((s) => s.name === step.name);
  if (existing >= 0) job.steps[existing] = { ...job.steps[existing], ...step };
  else job.steps.push(step);
  if (step.txHash) persist();
}

export function finishJob(
  jobId: string,
  outcome: { state: JobState; steps?: JobStep[]; error?: string },
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state = outcome.state;
  // The final result supersedes the live steps: it carries explorer links and the
  // per-step states the events could not know while they were still running.
  if (outcome.steps?.length) job.steps = outcome.steps;
  if (outcome.error) job.error = outcome.error;
  job.finishedAt = Date.now();
  persist();
}

/** Every job this caller started, newest first. Lets a client that lost its jobId
 *  (a refresh with no storage, a reinstall) find its own transfers again. */
export function jobsFor(caller: string, limit = 20): Job[] {
  const who = caller.toLowerCase();
  return [...jobs.values()]
    .filter((j) => j.caller.toLowerCase() === who)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}
