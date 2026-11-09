import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assignedAgent, createGitHub } from "../board/github.mjs";
import { createRelay as createBoardRelay } from "../board/relay.mjs";
import { createBoard, parseAgentTokens } from "../board/server.mjs";
import { createController } from "../orchestrator/controller.mjs";
import { createRelay } from "../orchestrator/relay.mjs";
import { createRunner } from "../orchestrator/runner.mjs";
import { configure } from "../orchestrator/start.mjs";
import { createStore } from "../orchestrator/store.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const luan = "l".repeat(40);
const friend = "f".repeat(40);
const sessionId = "0b6f3b1e-7c2a-4d7e-9a43-5d1f2f0c9e11";
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "agents-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("AGENT_TOKENS gives each agent its own token", () => {
  assert.deepEqual(parseAgentTokens(`luan-mac=${luan}, friend=${friend}`), {
    "luan-mac": luan,
    friend,
  });
  assert.deepEqual(parseAgentTokens(""), {});
  assert.throws(() => parseAgentTokens(`Luan=${luan}`), /valid agent name/);
  assert.throws(() => parseAgentTokens(`a=short`), /32\+ characters/);
  assert.throws(() => parseAgentTokens(`a=${luan},a=${friend}`), /twice/);
  assert.throws(() => parseAgentTokens(`a=${luan},b=${luan}`), /own token/);
});

test("the agent comes from the issue's agent: label", () => {
  assert.equal(
    assignedAgent({ labels: [{ name: "agent:luan-mac" }] }),
    "luan-mac",
  );
  assert.equal(assignedAgent({ labels: [{ name: "symphony-ready" }] }), null);
});

async function withAgentsBoard(run, extra = {}) {
  const fake = fakeGitHub();
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password: "correct horse battery",
    secure: false,
    agentTokens: { luan, friend },
    github: createGitHub({
      repo: "example/demo-app",
      token: "x",
      fetchImpl: fake.fetchImpl,
    }),
    ...extra,
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const owner = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { "Content-Type": "application/json", "X-Board": "1" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: response.status, body: await response.json() };
  };
  const inbox = async (token) =>
    (
      await fetch(`${base}/api/agent/inbox?wait=0`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
  await owner("/api/login", { password: "correct horse battery" });
  try {
    await run({ base, owner, inbox, fake });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("the owner gives a feature to an agent and only that agent hears about it", () =>
  withAgentsBoard(async ({ owner, inbox, fake }) => {
    assert.deepEqual(await inbox(luan), { agent: "luan", commands: [] });
    assert.deepEqual(await inbox(friend), { agent: "friend", commands: [] });
    // Nothing is assigned yet, and no unnamed agent takes unlabelled features.
    const unassigned = await owner("/api/features/3/chat", { text: "Hi" });
    assert.equal(unassigned.status, 409);
    assert.match(unassigned.body.error, /chưa được giao/);
    assert.equal(
      (await owner("/api/features/3/agent", { agent: "nobody" })).status,
      400,
    );

    const given = await owner("/api/features/3/agent", { agent: "luan" });
    assert.equal(given.status, 200);
    assert.deepEqual([given.body.before, given.body.changed], [null, true]);
    const issue = fake.issues.find((i) => i.number === 3);
    assert.ok(issue.labels.some((l) => l.name === "agent:luan"));
    assert.ok(
      fake.writes.some(
        (w) =>
          w.path === "/issues/3/comments" &&
          /Giao cho agent `luan`/.test(w.body.body),
      ),
    );

    assert.equal(
      (await owner("/api/features/3/chat", { text: "Hi" })).status,
      202,
    );
    assert.deepEqual((await inbox(luan)).commands, [
      { type: "message", issue: 3, text: "Hi" },
    ]);
    assert.deepEqual((await inbox(friend)).commands, []);

    const board = (await owner("/api/board")).body;
    assert.deepEqual(
      board.agent.agents.map((a) => [a.name, a.online]),
      [
        ["friend", true],
        ["luan", true],
      ],
    );
    assert.equal(board.agent.unnamed, false);
    assert.equal(board.features.find((f) => f.number === 3).agent, "luan");

    // Moving it tells the old agent to stop and swaps the label.
    const moved = await owner("/api/features/3/agent", { agent: "friend" });
    assert.deepEqual([moved.body.before, moved.body.changed], ["luan", true]);
    assert.deepEqual((await inbox(luan)).commands, [
      { type: "unassigned", issue: 3 },
    ]);
    assert.deepEqual(
      issue.labels
        .filter((l) => l.name.startsWith("agent:"))
        .map((l) => l.name),
      ["agent:friend"],
    );
    assert.ok(
      fake.writes.some((w) => /Trước đó là `luan`/.test(w.body?.body ?? "")),
    );
    assert.equal(
      (await owner("/api/features/3/agent", { agent: "friend" })).body.changed,
      false,
    );
  }));

test("an unnamed AGENT_TOKEN still takes every unlabelled feature", () =>
  withAgentsBoard(
    async ({ owner, inbox }) => {
      assert.equal(
        (await owner("/api/features/1/chat", { text: "Hi" })).status,
        202,
      );
      const solo = "s".repeat(40);
      assert.deepEqual(await inbox(solo), {
        agent: "",
        commands: [{ type: "message", issue: 1, text: "Hi" }],
      });
    },
    { agentTokens: {}, agentToken: "s".repeat(40) },
  ));

test("an agent that lost a feature does not hide the new agent's state", () => {
  const relay = createBoardRelay();
  relay.receive("friend", { states: [{ issue: 3, status: "running" }] });
  relay.receive("luan", { states: [{ issue: 3, status: "reassigned" }] });
  assert.equal(relay.view(3).state.agent, "friend");
  assert.equal(relay.view(3).state.status, "running");
  assert.deepEqual(relay.summary()[3], {
    status: "running",
    requests: 0,
    agent: "friend",
  });
});

test("a named orchestrator takes only its own features and lets go when one moves", () =>
  withDir(async (dir) => {
    const fake = fakeGitHub();
    const gh = createGitHub({
      repo: "example/demo-app",
      token: "x",
      fetchImpl: fake.fetchImpl,
    });
    const store = createStore(dir);
    const sent = [];
    const detached = [];
    const runner = {
      send: (issue, text) => sent.push({ issue, text }),
      busy: () => false,
      detach: (issue) => {
        detached.push(issue);
        store.update(issue, { status: "reassigned" });
      },
    };
    const make = (agent) =>
      createController({
        gh,
        labels,
        store,
        runner,
        workspaces: { prepare: async (n) => `/ws/${n}` },
        workflowPrompt: "Do {{ issue.identifier }}",
        agent,
      });
    const issue = fake.issues.find((i) => i.number === 3);
    // #3 is ready but unlabelled: a named agent leaves it alone.
    await make("luan").tick();
    assert.deepEqual(sent, []);
    issue.labels.push({ name: "agent:luan" });
    await make("luan").tick();
    assert.deepEqual(
      sent.map((s) => s.text),
      ["Do #3"],
    );
    // An unnamed orchestrator does not take a labelled feature.
    await make("").tick();
    assert.equal(sent.length, 1);
    issue.labels = issue.labels
      .filter((l) => l.name !== "agent:luan")
      .concat({ name: "agent:friend" });
    await make("luan").tick();
    assert.deepEqual(detached, [3]);
    await make("luan").tick();
    assert.deepEqual(detached, [3]);
    await assert.rejects(
      make("luan").handle({ type: "message", issue: 3, text: "x" }),
      /assigned to friend/,
    );
  }));

test("a reassigned feature stops its turn, keeps the old session aside and starts anew", () =>
  withDir(async (dir) => {
    const calls = [];
    const query = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: options.resume ?? sessionId,
        };
        if (calls.length === 1)
          await new Promise((resolve, reject) => {
            const { signal } = options.abortController;
            if (signal.aborted) reject(new Error("aborted"));
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          total_cost_usd: 0,
          session_id: sessionId,
        };
      })();
    };
    const store = createStore(dir);
    const runner = createRunner({ query, store, emit: () => {} });
    runner.send(4, "go", { workspace: "/w" });
    await until(() => store.get(4).sessionId === sessionId);
    runner.detach(4);
    await until(() => !runner.busy(4));
    const record = store.get(4);
    assert.equal(record.status, "reassigned");
    assert.equal(record.sessionId, null);
    assert.deepEqual(record.previousSessions, [sessionId]);
    runner.send(4, "back again", { workspace: "/w" });
    await until(() => store.get(4).status === "idle");
    assert.equal(calls[1].options.resume, undefined);
  }));

test("an orchestrator stops when its token belongs to another agent", async () => {
  const fetchImpl = async () =>
    Response.json({
      agent: "friend",
      commands: [{ type: "message", issue: 1 }],
    });
  const handled = [];
  const relay = createRelay({
    boardUrl: "http://board:8080",
    token: luan,
    agent: "luan",
    fetchImpl,
    log: () => {},
  });
  await assert.rejects(
    relay.listen((c) => handled.push(c), { waitSeconds: 0 }),
    /AGENT_NAME is "luan" but the board knows this token as "friend"/,
  );
  assert.deepEqual(handled, []);
});

test("configure reads AGENT_NAME", () => {
  const manifest = {
    runtime: { orchestrator: "claude" },
    tracker: { kind: "github", repo: "a/b" },
  };
  const env = {
    BOARD_URL: "http://board:8080",
    AGENT_TOKEN: luan,
    GITHUB_TOKEN: "g",
  };
  assert.equal(configure(manifest, env).agent, "");
  assert.equal(
    configure(manifest, { ...env, AGENT_NAME: "luan-mac" }).agent,
    "luan-mac",
  );
  assert.throws(
    () => configure(manifest, { ...env, AGENT_NAME: "Luan Mac" }),
    /AGENT_NAME/,
  );
});
