/**
 * Sandbox containment probe. Model output is untrusted code, so the flags in
 * run.ts are only worth anything if something actually tests them — otherwise
 * a typo in the docker args silently removes a boundary and every later
 * "verified" claim is worthless.
 *
 * Runs the probe INSIDE the container and asserts each boundary.
 */
import { runInSandbox } from "../evals/sandbox/run.ts";

const probe = `
import socket
r = {}
try:
    socket.create_connection(("1.1.1.1", 53), timeout=3)
    r["network"] = "REACHED"
except Exception:
    r["network"] = "blocked"
try:
    open("/work/solution.py", "a").write("# tampered")
    r["work_write"] = "ALLOWED"
except Exception:
    r["work_write"] = "blocked"
try:
    open("/tmp/e", "w").write("x")
    r["tmpfs_write"] = "allowed"
except Exception:
    r["tmpfs_write"] = "blocked"
import os
r["uid"] = os.getuid()
try:
    open("/etc/hostname").read()
    r["etc_read"] = "readable"
except Exception:
    r["etc_read"] = "blocked"
print(r)
`;

const res = await runInSandbox(
  { "solution.py": probe },
  ["-c", "exec(open('solution.py').read())"]
);

const line = res.stdout.trim().split("\n").pop() ?? "";
let got: Record<string, unknown> = {};
try {
  got = Object.fromEntries(
    line
      .replace(/[{}']/g, "")
      .split(", ")
      .map((kv) => kv.split(": "))
  );
} catch {
  /* reported below */
}

let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log(`sandbox probe: ${line}\n`);
check("no outbound network", got.network === "blocked", String(got.network));
check("tests are read-only (model cannot tamper)", got.work_write === "blocked", String(got.work_write));
check("tmpfs writable as intended", got.tmpfs_write === "allowed", String(got.tmpfs_write));
check("runs as non-root (uid 1000)", got.uid === "1000", String(got.uid));

console.log(
  bad
    ? `\n${bad} CONTAINMENT BOUNDARY(IES) MISSING — model output is not sandboxed as intended`
    : "\nSANDBOX CONTAINMENT OK"
);
process.exit(bad ? 1 : 0);