import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

// Codex protects Git metadata even inside workspace-write. Symphony's fresh
// clone owns its .git directory; permit that directory without broadening the
// sandbox to the worker host or another checkout's common Git directory.
export function rewriteMessage(line, workspace) {
  const message = JSON.parse(line);
  if (message.method !== "turn/start") return line;
  const params = message.params;
  if (params?.sandboxPolicy?.type !== "workspaceWrite") return line;
  const root = realpathSync(workspace);
  const cwd = params.cwd ?? root;
  if (!isAbsolute(cwd)) throw new Error("Symphony turn cwd must be absolute");
  const inside = relative(root, realpathSync(cwd));
  if (inside === ".." || inside.startsWith("../") || isAbsolute(inside))
    throw new Error("Symphony turn cwd is outside its issue workspace");
  const git = join(root, ".git");
  if (!statSync(git).isDirectory() || realpathSync(git) !== git)
    throw new Error("Symphony requires an issue-local Git metadata directory");
  const roots = params.sandboxPolicy.writableRoots ?? [];
  if (!Array.isArray(roots)) throw new Error("Invalid writableRoots policy");
  // Preserve the configured policy and add one narrowly scoped directory.
  params.sandboxPolicy.writableRoots = [...new Set([...roots, git])];
  return JSON.stringify(message);
}

export function startServer() {
  const workspace = realpathSync(process.cwd());
  const child = spawn("codex", ["app-server"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let stopping = false;
  let force;
  const input = new Transform({
    transform(chunk, _encoding, done) {
      try {
        pending += decoder.write(chunk);
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024)
          throw new Error("Symphony protocol record exceeds 16 MiB");
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          this.push(`${rewriteMessage(line, workspace)}\n`);
        }
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        pending += decoder.end();
        if (pending) this.push(`${rewriteMessage(pending, workspace)}\n`);
        done();
      } catch (error) {
        done(error);
      }
    },
  });
  function stop(signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    process.stdin.unpipe(input);
    child.kill(signal);
    force = setTimeout(() => child.kill("SIGKILL"), 2000);
    force.unref();
  }
  function fail() {
    // Protocol data can contain task inputs. Never include it in stderr.
    console.error(
      "Symphony Codex bridge failed; inspect protocol and issue-local Git setup.",
    );
    process.exitCode = 1;
    stop();
  }
  process.stdin.pipe(input).pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  input.on("error", fail);
  child.on("error", fail);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") fail();
  });
  process.stdout.on("error", () => stop());
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => stop(signal));
  child.on("close", (code, signal) => {
    clearTimeout(force);
    process.stdin.unpipe(input);
    process.stdin.pause();
    process.exitCode ??= code ?? (signal && stopping ? 0 : 1);
  });
}

export const main = startServer;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startServer();
