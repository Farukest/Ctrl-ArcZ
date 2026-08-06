import type { Session } from '@ctrl-arcz/demo-kit';
import { signedPost } from './signedPost.js';

/**
 * Start a bridge and follow it, instead of holding a request open for half a minute.
 *
 * The transfer never depended on the browser: nothing on the server aborts when a
 * client disconnects, so closing the tab mid-bridge always left the money moving.
 * What it lost was every way of finding out. One blocking request meant one chance
 * to hear the answer, and a refresh, a tab change or a dropped connection spent it.
 *
 * The jobId is written to storage before the request that produces it can be
 * forgotten, so a reload picks the transfer back up rather than starting over.
 */

export interface JobStep {
  name: string;
  state?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export interface BridgeJob {
  jobId: string;
  engine: 'cctp' | 'gateway';
  from: string;
  to: string;
  amount: string;
  state: 'running' | 'success' | 'failed' | 'unknown';
  steps: JobStep[];
  startedAt: number;
  error?: string;
}

const KEY = 'ctrl-arcz:bridge-jobs';

/**
 * Every transfer this browser is still following. A list rather than a slot, because
 * a bridge takes half a minute and there is no reason a second one should wait for
 * the first: the server runs them independently, and locking the button was only
 * ever a symptom of the page having one place to remember a job.
 */
export function activeJobIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids.slice(-10)));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or a full quota. The bridge still runs and still reports; only
    // surviving a reload is lost, which is worth a degraded experience, not an error.
  }
}

/** Start the transfer. Returns as soon as the server has accepted it. */
export async function startBridgeJob(
  session: Session,
  engine: 'cctp' | 'gateway',
  params: { from: string; to: string; amount: string },
): Promise<string> {
  const { jobId } = await signedPost<{ jobId: string }>(
    session,
    engine === 'gateway' ? '/api/gateway' : '/api/bridge',
    { ...params, async: true },
  );
  write([...activeJobIds(), jobId]);
  return jobId;
}

/**
 * Read a job's state. Unauthenticated by design on the server: the id is the
 * credential, and the body holds nothing a block explorer would not show.
 */
export async function readBridgeJob(jobId: string): Promise<BridgeJob | null> {
  try {
    const res = await fetch(`/api/bridge/${jobId}`);
    const body = (await res.json()) as BridgeJob & { state?: string };
    if (res.status === 404) return { ...body, jobId, state: 'unknown' } as BridgeJob;
    if (!res.ok) return null;
    return body;
  } catch {
    // A failed poll is not a failed transfer. Say nothing and let the next one try.
    return null;
  }
}

/** Stop following one job. The transfer is unaffected; only this browser lets go. */
export function forgetJob(jobId: string): void {
  write(activeJobIds().filter((id) => id !== jobId));
}
