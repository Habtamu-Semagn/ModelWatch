/**
 * Host-side safety net for sandbox containers. A container that outlives its
 * timeout gets SIGKILLed (not a graceful stop): we don't care about its state,
 * only that the host stays clean.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ReapOptions {
  timeoutMs: number;
  pollMs?: number;
  onTimeout?: (ms: number) => void;
}

/**
 * Race a promise against a timer. On expiry runs `kill` and throws so the
 * caller cannot accidentally continue on an unfinished result.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  kill: () => Promise<void>,
  opts: ReapOptions
): Promise<T> {
  const pollMs = opts.pollMs ?? 50;
  const started = Date.now();
  let timedOut = false;

  const timer = setInterval(async () => {
    if (timedOut || Date.now() - started < opts.timeoutMs) return;
    timedOut = true;
    clearInterval(timer);
    opts.onTimeout?.(Date.now() - started);
    try {
      await kill();
    } catch {
      /* already gone */
    }
  }, pollMs);

  try {
    return await work;
  } finally {
    clearInterval(timer);
    if (timedOut) throw new Error(`sandbox exceeded ${opts.timeoutMs}ms and was killed`);
  }
}

export async function killContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["kill", name]);
}

export async function removeContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", name]);
}