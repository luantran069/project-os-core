import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
const { archiveWorkspace } = await import(
  new URL("../symphony/archive.mjs", import.meta.url).href
);
const execute = promisify(execFile);

test("terminal archival retains untracked files and repairs a relocated nested Git worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-archive-test-"));
  try {
    const original = join(directory, ".symphony/workspaces/SCRUM-fixture");
    await mkdir(original, { recursive: true });
    const git = (args: string[], cwd = original) =>
      execute("git", args, { cwd });
    await git(["init", "-b", "master"]);
    await writeFile(join(original, "tracked.txt"), "original\n");
    await git(["add", "tracked.txt"]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "synthetic initial commit",
    ]);
    const task = join(original, ".symphony/task-worktrees/task");
    await git(["worktree", "add", "-b", "codex/archive-fixture", task]);
    await writeFile(join(task, "tracked.txt"), "retained modification\n");
    await writeFile(join(task, "untracked.txt"), "retained untracked work\n");
    await mkdir(join(original, "node_modules/cache"), { recursive: true });
    await writeFile(
      join(original, "node_modules/cache/fixture"),
      "retained dependency cache\n",
    );
    const archived = await archiveWorkspace(original);
    assert.equal(
      await access(original).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await readFile(join(archived, "node_modules/cache/fixture"), "utf8"),
      "retained dependency cache\n",
    );
    const relocated = join(archived, ".symphony/task-worktrees/task");
    assert.equal(
      await readFile(join(relocated, "untracked.txt"), "utf8"),
      "retained untracked work\n",
    );
    const status = await git(["status", "--short", "--branch"], relocated);
    assert.match(status.stdout, /codex\/archive-fixture/);
    assert.match(status.stdout, / M tracked.txt/);
    assert.match(status.stdout, /\?\? untracked.txt/);
    const listed = await git(["worktree", "list", "--porcelain"], archived);
    assert.ok(listed.stdout.includes(`worktree ${archived}\n`));
    assert.ok(listed.stdout.includes(`worktree ${relocated}\n`));
    assert.ok(!listed.stdout.includes(original));
    const common = await git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      relocated,
    );
    assert.equal(common.stdout.trim(), join(archived, ".git"));
    const gitPointer = await readFile(join(relocated, ".git"), "utf8");
    assert.ok(gitPointer.includes(join(archived, ".git/worktrees/")));
    await git(
      ["show-ref", "--verify", "refs/heads/codex/archive-fixture"],
      archived,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archival rejects unrelated directories and symlink Git directories without moving them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-archive-safety-"));
  try {
    await assert.rejects(archiveWorkspace(directory), /direct issue children/);
    const original = join(directory, ".symphony/workspaces/SCRUM-fixture");
    const outside = join(directory, "outside-git");
    await mkdir(original, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(original, ".git"));
    await assert.rejects(archiveWorkspace(original), /real directories/);
    await access(original);
    await access(outside);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git inspection failure still retains the whole repository before reporting repair failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-archive-corrupt-"));
  try {
    const original = join(directory, ".symphony/workspaces/SCRUM-fixture");
    await mkdir(join(original, ".git"), { recursive: true });
    await writeFile(
      join(original, "untracked.txt"),
      "preserve even if Git is damaged\n",
    );
    await assert.rejects(archiveWorkspace(original), /Repository retained/);
    const archives = join(directory, ".symphony/archives");
    const entries = await readdir(archives);
    assert.equal(entries.length, 1);
    assert.equal(
      await readFile(join(archives, entries[0], "untracked.txt"), "utf8"),
      "preserve even if Git is damaged\n",
    );
    assert.equal(
      await access(original).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
