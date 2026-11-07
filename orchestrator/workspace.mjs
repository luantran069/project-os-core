import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Each feature gets its own copy of the repository, made by WORKFLOW.md's
// after_create hook, exactly as under Symphony. The session runs there, so
// `claude --resume <id>` must be run from the same directory.

export const workspacePath = (root, issue) => join(root, String(Number(issue)));

function runHook(script, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(`after_create hook failed (${signal ?? `exit ${code}`})`),
          );
    });
  });
}

export function createWorkspaces({ root, hooks = {}, run = runHook }) {
  const pending = new Map();
  async function create(path) {
    await mkdir(path, { recursive: true });
    try {
      if (hooks.after_create)
        await run(hooks.after_create, path, hooks.timeout_ms ?? 180_000);
    } catch (error) {
      // A half-made copy would be reused next time; start clean instead.
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
  // The feature's workspace, made on first use.
  function prepare(issue) {
    const path = workspacePath(root, issue);
    if (existsSync(path) && !pending.has(path)) return Promise.resolve(path);
    if (!pending.has(path))
      pending.set(
        path,
        create(path).finally(() => pending.delete(path)),
      );
    return pending.get(path).then(() => path);
  }
  return { prepare };
}
