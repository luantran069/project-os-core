import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitHub } from "../board/github.mjs";
import { createBoard, readTokens } from "../board/server.mjs";
import { mcpUrl, run, setEnv } from "../board/token.mjs";
import {
  callerOf,
  fingerprint,
  hashToken,
  isHash,
  matches,
} from "../board/tokens.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const luan = "l".repeat(40);
const friend = "f".repeat(40);
const ai = "a".repeat(40);

test("a fingerprint stands for its token and nothing else", () => {
  const print = hashToken(luan);
  assert.match(print, /^sha256:[0-9a-f]{64}$/);
  assert.ok(isHash(print));
  assert.equal(fingerprint(print), print);
  assert.equal(fingerprint(luan), print);
  assert.ok(matches(print, `Bearer ${luan}`));
  assert.ok(matches(luan, `Bearer ${luan}`));
  assert.ok(!matches(print, `Bearer ${friend}`));
  // The fingerprint itself is not a token.
  assert.ok(!matches(print, `Bearer ${print}`));
  assert.ok(!matches(print, luan));
  assert.ok(!matches(print, "Bearer "));
  assert.equal(callerOf({ luan: print, "": friend }, `Bearer ${friend}`), "");
  assert.equal(callerOf({ luan: print }, `Bearer ${friend}`), null);
});

test("the board reads tokens or fingerprints, and no two alike", () => {
  const env = {
    AGENT_TOKENS: `luan=${hashToken(luan)}, friend=${friend}`,
    BOARD_MCP_TOKENS: `luan-mac=${hashToken(ai)}`,
  };
  assert.deepEqual(readTokens(env), {
    agentToken: "",
    agentTokens: { luan: hashToken(luan), friend },
    mcpToken: "",
    mcpTokens: { "luan-mac": hashToken(ai) },
  });
  assert.deepEqual(readTokens({}), {
    agentToken: "",
    agentTokens: {},
    mcpToken: "",
    mcpTokens: {},
  });
  assert.throws(
    () => readTokens({ AGENT_TOKENS: "luan=sha256:abc" }),
    /sha256: and 64 hex/,
  );
  assert.throws(
    () => readTokens({ BOARD_MCP_TOKEN: "short" }),
    /BOARD_MCP_TOKEN needs 32\+ characters/,
  );
  // A token and its own fingerprint are the same machine.
  assert.throws(
    () => readTokens({ AGENT_TOKENS: `a=${luan},b=${hashToken(luan)}` }),
    /own token/,
  );
  assert.throws(
    () =>
      readTokens({
        AGENT_TOKENS: `a=${luan}`,
        BOARD_MCP_TOKENS: `b=${hashToken(luan)}`,
      }),
    /BOARD_MCP_TOKEN and BOARD_MCP_TOKENS must differ from every token in AGENT_TOKEN/,
  );
  assert.throws(
    () => readTokens({ BOARD_MCP_TOKEN: ai, BOARD_MCP_TOKENS: `x=${ai}` }),
    /own token/,
  );
  assert.throws(
    () => readTokens({ BOARD_MCP_TOKENS: `Luan=${ai}` }),
    /BOARD_MCP_TOKENS: "Luan" is not a valid agent name/,
  );
});

async function withBoard(run) {
  const fake = fakeGitHub();
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password: "correct horse battery",
    secure: false,
    agentTokens: { luan: hashToken(luan) },
    mcpTokens: { "luan-mac": hashToken(ai) },
    github: createGitHub({
      repo: "example/demo-app",
      token: "x",
      fetchImpl: fake.fetchImpl,
    }),
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, fake });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("a board holding only fingerprints lets each machine in with its token", () =>
  withBoard(async ({ base, fake }) => {
    const inbox = (token) =>
      fetch(`${base}/api/agent/inbox?wait=0`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    assert.deepEqual(await (await inbox(luan)).json(), {
      agent: "luan",
      commands: [],
    });
    assert.equal((await inbox(hashToken(luan))).status, 401);
    assert.equal((await inbox(ai)).status, 401);

    const mcp = (token, body) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    assert.equal((await mcp(ai, ping)).status, 200);
    assert.equal((await mcp(hashToken(ai), ping)).status, 401);
    assert.equal((await mcp(luan, ping)).status, 401);

    // Decisions name the machine whose token made them.
    const reply = await (
      await mcp(ai, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "decide", arguments: { number: 2, action: "approve" } },
      })
    ).json();
    assert.equal(reply.result.isError, undefined);
    const comment = fake.writes.find((w) => w.path === "/issues/2/comments");
    assert.match(
      comment.body.body,
      /Duyệt G2: cho làm\*\* \(AI của `luan-mac`, qua MCP\)/,
    );
  }));

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "board-token-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("env lines are set in place and the rest kept", () => {
  assert.equal(
    setEnv("BOARD_URL=https://b\nAGENT_NAME=old\n# note\n", {
      AGENT_NAME: "luan",
      AGENT_TOKEN: "t",
    }),
    "BOARD_URL=https://b\nAGENT_NAME=luan\n# note\nAGENT_TOKEN=t\n",
  );
  assert.equal(setEnv("", { A: "1" }), "A=1\n");
});

test("an agent's token goes into its .env and only the fingerprint is shown", () =>
  withDir(async (dir) => {
    const lines = [];
    const out = (line) => lines.push(line);
    await writeFile(join(dir, ".env"), "BOARD_URL=https://board.example\n");
    await run(["agent", "friend-mac"], { cwd: dir, out });
    const env = await readFile(join(dir, ".env"), "utf8");
    const token = env.match(/^AGENT_TOKEN=([0-9a-f]{64})$/m)[1];
    assert.match(env, /^BOARD_URL=https:\/\/board\.example$/m);
    assert.match(env, /^AGENT_NAME=friend-mac$/m);
    assert.equal((await stat(join(dir, ".env"))).mode & 0o777, 0o600);
    const printed = lines.join("\n");
    assert.ok(!printed.includes(token));
    assert.ok(printed.includes(`friend-mac=${hashToken(token)}`));

    await assert.rejects(
      run(["agent", "friend-mac"], { cwd: dir, out }),
      /already has an AGENT_TOKEN/,
    );
    await run(["agent", "friend-mac", "--force"], { cwd: dir, out });
    assert.ok(!(await readFile(join(dir, ".env"), "utf8")).includes(token));
    await assert.rejects(run(["agent", "Friend"], { cwd: dir, out }), /a-z/);
  }));

test("an AI's token goes into Claude Code and only the fingerprint is shown", () =>
  withDir(async (dir) => {
    const lines = [];
    const calls = [];
    const exec = async (file, args) => calls.push([file, args]);
    await writeFile(
      join(dir, "project.yaml"),
      "project:\n  name: Happy Clink\n",
    );
    await run(["mcp", "luan-mac", "--board", "https://board.example/"], {
      cwd: dir,
      env: {},
      exec,
      out: (line) => lines.push(line),
    });
    const [[file, args]] = calls;
    assert.equal(file, "claude");
    assert.deepEqual(args.slice(0, 8), [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "happy-clink-board",
      "https://board.example/mcp",
    ]);
    const token = args[9].match(/^Authorization: Bearer ([0-9a-f]{64})$/)[1];
    const printed = lines.join("\n");
    assert.ok(!printed.includes(token));
    assert.ok(printed.includes(`luan-mac=${hashToken(token)}`));

    const failing = async () => {
      throw Object.assign(new Error(`ran with ${token}`), {
        stderr: "MCP server happy-clink-board already exists\n",
      });
    };
    const error = await run(
      ["mcp", "luan-mac", "--board", "https://board.example"],
      { cwd: dir, env: {}, exec: failing, out: () => {} },
    ).catch((e) => e);
    assert.match(error.message, /already exists.*claude mcp remove/);
    assert.ok(!error.message.includes(token));
    await assert.rejects(
      run(["mcp", "x", "--board", "https://b.example", "--scope", "project"], {
        cwd: dir,
        exec,
      }),
      /\.mcp\.json/,
    );
  }));

test("the board address becomes its /mcp URL, https only off localhost", () => {
  assert.equal(mcpUrl("https://b.example/mcp/"), "https://b.example/mcp");
  assert.equal(mcpUrl("https://b.example/sub"), "https://b.example/sub/mcp");
  assert.equal(mcpUrl("http://localhost:8080"), "http://localhost:8080/mcp");
  assert.throws(() => mcpUrl("http://b.example"), /https/);
  assert.throws(() => mcpUrl("b.example"), /board's address/);
});

test("hash prints the fingerprint of a piped token", async () => {
  const lines = [];
  await run(["hash"], {
    stdin: async () => `${luan}\n`,
    out: (line) => lines.push(line),
  });
  assert.deepEqual(lines, [hashToken(luan)]);
  await assert.rejects(run(["hash"], { stdin: async () => "short" }), /32\+/);
});
