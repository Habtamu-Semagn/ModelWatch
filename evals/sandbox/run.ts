/**
 * Model output executes HERE and nowhere else.
 *
 *   docker run --rm --network=none --read-only
 *     --tmpfs /tmp:rw,size=64m --memory 256m --pids-limit 64 --cpus 0.5
 *     --user 1000:1000 -v <dir>:/work:ro -w /work <image> <argv...>
 *
 * Plus a 30s host-side kill (reaper.ts). /work is read-only, so model code
 * cannot rewrite its own tests.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { killContainer, withDeadline } from "./reaper.ts";

const execFileAsync = promisify(execFile);

const IMAGE = process.env.SANDBOX_IMAGE ?? "evalkit-sandbox:py311";
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 30_000);

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run argv inside the locked-down container against `files` in a temp dir. */
export async function runInSandbox(
  files: Record<string, string>,
  argv: string[]
): Promise<SandboxResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "evalkit-"));
  const name = `evalkit-sb-${randomBytes(6).toString("hex")}`;
  const started = Date.now();

  try {
    await mkdir(path.join(dir, "work"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, "work", rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      await chmod(target, 0o644);
    }
    // The host uid must own the dir so `--user 1000:1000` can read it.
    await chmod(dir, 0o755);
    await chmod(path.join(dir, "work"), 0o755);

    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=64m",
      "--memory",
      "256m",
      "--pids-limit",
      "64",
      "--cpus",
      "0.5",
      "--user",
      "1000:1000",
      "-v",
      `${path.join(dir, "work")}:/work:ro`,
      "-w",
      "/work",
      IMAGE,
      ...argv,
    ];

    const child = execFileAsync("docker", args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });

    const work = child.then(
      (r) => ({ exitCode: 0 as number | null, stdout: r.stdout, stderr: r.stderr }),
      (e: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => {
        // execFile rejects on nonzero exit AND on signal; both are normal here.
        const signaled = typeof e.code === "string" && e.code.startsWith("SIG");
        return {
          exitCode: signaled || e.code == null ? null : Number(e.code),
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(e.message ?? e),
        };
      }
    );

    const result = await withDeadline(work, () => killContainer(name), {
      timeoutMs: TIMEOUT_MS,
      onTimeout: (ms) => console.error(`[sandbox] timeout after ${ms}ms, killing ${name}`),
    });

    return {
      ...result,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}