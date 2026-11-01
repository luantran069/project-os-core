import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  copyFile,
  symlink,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

async function fixture(approval: string, tracker = "") {
  const directory = await mkdtemp(join(tmpdir(), "symphony-probe-"));
  const vendored = join(directory, ".project-os/symphony");
  await mkdir(vendored, { recursive: true });
  await mkdir(join(directory, "bin"));
  for (const name of ["probe.mjs", "project.mjs", "codex.mjs"])
    await copyFile(join(repository, "symphony", name), join(vendored, name));
  await symlink(
    join(repository, "node_modules"),
    join(directory, "node_modules"),
  );
  await writeFile(
    join(vendored, "runtime.json"),
    JSON.stringify({ version: "v0.0.3" }),
  );
  await writeFile(
    join(directory, "WORKFLOW.md"),
    `---\n${tracker ? `tracker:\n  kind: ${tracker}\n` : ""}codex:\n  command: node .project-os/symphony/codex.mjs\n  approval_policy: ${approval}\n  thread_sandbox: workspace-write\n---\nFixture\n`,
  );
  // A process fixture exercises the real probe's request/response and shutdown
  // handling. It rejects the historical policy exactly where the real CLI does.
  await writeFile(
    join(directory, "bin", "codex"),
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  appendFileSync('requests.jsonl', line + '\\n');
  if (!Object.hasOwn(message, 'id')) return;
  let result = {};
  if (message.method === 'thread/loaded/list') result = { data: [] };
  if (message.method === 'thread/start') {
    if (message.params.approvalPolicy !== 'never') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'unknown variant reject' } }) + '\\n');
      return;
    }
    result = { thread: { id: 'fixture-ephemeral' }, approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } };
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
// The probe closes stdin and sends SIGTERM. Either EOF or the signal may win;
// both paths must record actual process exit before the parent reports success.
process.on('exit', () => { writeFileSync('stopped', 'yes'); });
process.on('SIGTERM', () => { process.exit(0); });
`,
    { mode: 0o755 },
  );
  return {
    directory,
    execute: () =>
      run(process.execPath, [join(vendored, "probe.mjs")], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH}`,
        },
        timeout: 10_000,
      }),
  };
}

test("Codex probe verifies the configured policy and actual pinned Jira tool in an ephemeral thread without starting a turn", async () => {
  const host = await fixture("never");
  try {
    const result = await host.execute();
    assert.match(result.stdout, /ephemeral thread/);
    const requests = (
      await readFile(join(host.directory, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      requests.map((request) => request.method),
      ["initialize", "initialized", "thread/loaded/list", "thread/start"],
    );
    assert.equal(requests[0].params.capabilities.experimentalApi, true);
    const started = requests[3].params;
    assert.equal(started.ephemeral, true);
    assert.equal(started.approvalPolicy, "never");
    assert.equal(started.sandbox, "workspace-write");
    assert.equal(started.cwd, host.directory);
    assert.equal(started.dynamicTools.length, 1);
    const jira = started.dynamicTools[0];
    assert.equal(jira.name, "jira_rest");
    assert.equal(
      jira.type,
      undefined,
      "Use v0.0.3's wire payload rather than a newer generated schema",
    );
    assert.deepEqual(jira.inputSchema.required, ["method", "path"]);
    assert.deepEqual(jira.inputSchema.properties.method.enum, [
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
    assert.equal(
      await readFile(join(host.directory, "stopped"), "utf8"),
      "yes",
    );
  } finally {
    await rm(host.directory, { recursive: true, force: true });
  }
});

test("Codex probe sends the pinned GitHub tool for GitHub projects", async () => {
  const host = await fixture("never", "github");
  try {
    const result = await host.execute();
    assert.match(result.stdout, /pinned github_api tool/);
    const requests = (
      await readFile(join(host.directory, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const [tool] = requests[3].params.dynamicTools;
    assert.equal(tool.name, "github_api");
    assert.deepEqual(tool.inputSchema.properties.method.enum, [
      "GET",
      "POST",
      "PATCH",
      "PUT",
      "DELETE",
    ]);
    assert.ok("params" in tool.inputSchema.properties);
  } finally {
    await rm(host.directory, { recursive: true, force: true });
  }
});

test("Codex probe catches a thread/start rejection after successful initialization and stops its child", async () => {
  const host = await fixture(
    "{reject: {sandbox_approval: true, rules: true, mcp_elicitations: true}}",
  );
  try {
    await assert.rejects(
      host.execute(),
      (error: Error & { stderr?: string }) => {
        assert.match(
          error.stderr ?? "",
          /Codex rejected thread\/start \(code -32600\)/,
        );
        return true;
      },
    );
    assert.equal(
      await readFile(join(host.directory, "stopped"), "utf8"),
      "yes",
    );
  } finally {
    await rm(host.directory, { recursive: true, force: true });
  }
});
