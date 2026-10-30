import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function realDirectory(path) {
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Archival requires real directories without symlink redirection",
    );
}

export async function archiveWorkspace(workspace = process.cwd()) {
  const original = resolve(workspace);
  const workspaces = dirname(original);
  const symphony = dirname(workspaces);
  if (
    basename(workspaces) !== "workspaces" ||
    basename(symphony) !== ".symphony"
  )
    throw new Error(
      "Archive only direct issue children of .symphony/workspaces",
    );
  for (const directory of [
    symphony,
    workspaces,
    original,
    join(original, ".git"),
  ])
    await realDirectory(directory);
  const archives = join(symphony, "archives");
  await mkdir(archives, { mode: 0o700, recursive: true });
  await realDirectory(archives);

  // Runtime ignores hook failures. Git errors must never prevent the rename
  // that protects the repository from terminal cleanup.
  let tasks;
  let inspectionFailed = false;
  try {
    const listed = await execute(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      { cwd: original },
    );
    tasks = listed.stdout
      .split("\0")
      .filter((item) => item.startsWith("worktree "))
      .map((item) => resolve(item.slice("worktree ".length)))
      .filter((path) => path !== original)
      .map((path) => {
        const suffix = relative(original, path);
        if (
          isAbsolute(suffix) ||
          suffix === ".." ||
          suffix.startsWith(`..${sep}`)
        )
          throw new Error("Worktree is outside the issue repository");
        return suffix;
      });
    for (const suffix of tasks) await realDirectory(join(original, suffix));
  } catch {
    inspectionFailed = true;
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const destination = join(
    archives,
    `${basename(original)}-${stamp}-${randomUUID()}`,
  );
  await rename(original, destination);
  if (inspectionFailed)
    throw new Error(
      `Repository retained at ${destination}; inspect and repair Git worktrees manually`,
    );
  try {
    await execute(
      "git",
      ["worktree", "repair", ...tasks.map((path) => join(destination, path))],
      { cwd: destination },
    );
  } catch {
    throw new Error(
      `Repository retained at ${destination}; Git worktree repair failed`,
    );
  }
  return destination;
}

export function main() {
  return archiveWorkspace()
    .then((destination) => {
      console.log(
        `Preserved issue repository and task worktrees: ${destination}`,
      );
    })
    .catch((error) => {
      console.error(`Symphony archival: ${error.message}`);
      process.exitCode = 1;
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
