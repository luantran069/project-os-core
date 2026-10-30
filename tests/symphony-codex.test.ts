import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const { rewriteMessage } = await import(
  new URL("../symphony/codex.mjs", import.meta.url).href
);
const wrapper = fileURLToPath(
  new URL("../symphony/codex.mjs", import.meta.url),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "symphony-codex-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin", "codex"),
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => process.stdout.write(line + '\\n'));
process.on('exit', () => writeFileSync('stopped', 'yes'));
process.on('SIGTERM', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return root;
}

function turn(cwd?: string) {
  return {
    id: 3,
    method: "turn/start",
    params: {
      threadId: "fixture",
      input: [{ type: "text", text: "Vietnamese: Ý tưởng" }],
      ...(cwd ? { cwd } : {}),
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
    },
  };
}

test("bridge grants only the issue's Git metadata and preserves pinned turn settings", async () => {
  const root = await fixture();
  try {
    for (const cwd of [root, undefined]) {
      const message = turn(cwd);
      const updated = JSON.parse(rewriteMessage(JSON.stringify(message), root));
      assert.deepEqual(updated.params.sandboxPolicy, {
        ...message.params.sandboxPolicy,
        writableRoots: [join(root, ".git")],
      });
      assert.deepEqual(updated.params.input, message.params.input);
      assert.equal(updated.params.approvalPolicy, "never");
      assert.equal(updated.params.cwd, cwd);
    }
    const initialize =
      '{ "id": 1, "method": "initialize", "params": {"capabilities":{"experimentalApi":true}} }';
    assert.equal(rewriteMessage(initialize, root), initialize);
    const readonly = JSON.stringify({
      ...turn(root),
      params: { sandboxPolicy: { type: "readOnly" } },
    });
    assert.equal(rewriteMessage(readonly, root), readonly);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge refuses an external cwd and shared or symlinked Git metadata", async () => {
  const root = await fixture();
  const outside = await fixture();
  try {
    assert.throws(
      () => rewriteMessage(JSON.stringify(turn(outside)), root),
      /outside its issue workspace/,
    );
    await rm(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    assert.throws(
      () => rewriteMessage(JSON.stringify(turn(root)), root),
      /issue-local Git metadata/,
    );
    await rm(join(root, ".git"));
    await symlink(join(outside, ".git"), join(root, ".git"));
    assert.throws(
      () => rewriteMessage(JSON.stringify(turn(root)), root),
      /issue-local Git metadata/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stdio bridge preserves message order, split UTF-8 and child cleanup", async () => {
  const root = await fixture();
  try {
    const child = spawn(process.execPath, [wrapper], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const stopped = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const messages = [
      JSON.stringify({ id: 1, method: "initialize", params: {} }),
      JSON.stringify({ method: "initialized", params: {} }),
      ...Array.from({ length: 200 }, (_, id) =>
        JSON.stringify({ ...turn(root), id: id + 2 }),
      ),
    ];
    const input = Buffer.from(messages.join("\n") + "\n");
    // Deliberately split a multibyte code point between stream chunks.
    const split = input.indexOf(Buffer.from("Ý")) + 1;
    child.stdin.write(input.subarray(0, split));
    child.stdin.end(input.subarray(split));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const code = await stopped;
    clearTimeout(timer);
    assert.equal(code, 0, errors);
    const received = output.trim().split("\n");
    assert.equal(received.length, messages.length);
    assert.equal(received[0], messages[0]);
    assert.equal(received[1], messages[1]);
    for (let index = 2; index < received.length; index++) {
      const message = JSON.parse(received[index]);
      assert.equal(message.id, index);
      assert.deepEqual(message.params.input, turn(root).params.input);
      assert.deepEqual(message.params.sandboxPolicy.writableRoots, [
        join(root, ".git"),
      ]);
    }
    assert.equal(await readFile(join(root, "stopped"), "utf8"), "yes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
