// The owner's chat builds a feature itself (core 0.11.0): reserved `chat` and
// `chat-<suffix>` agents, claim_feature, no orchestrator session, and the
// stall warning when the chat's workpad stands still.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  chatAgent,
  chatHold,
  createGitHub,
  isChatAgent,
} from "../board/github.mjs";
import { createBoard, parseAgentTokens } from "../board/server.mjs";
import { createController } from "../orchestrator/controller.mjs";
import { configure } from "../orchestrator/start.mjs";
import { createStore } from "../orchestrator/store.mjs";
import { parseWorkflow } from "../symphony/project.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const mcpToken = "m".repeat(40);
const luan = "l".repeat(40);
const solo = "s".repeat(40);
const hour = 3_600_000;
// The fake's comments and issues are dated 2026-10-30 10:00 UTC.
const at = Date.parse("2026-10-30T10:00:00Z");

async function withBoard(run, extra = {}) {
  const fake = fakeGitHub();
  const clock = { now: at + hour };
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password: "correct horse battery",
    secure: false,
    mcpToken,
    agentTokens: { luan },
    now: () => clock.now,
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
  let id = 0;
  const tool = async (name, args = {}) => {
    const reply = await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    ).json();
    assert.ok(reply.result, JSON.stringify(reply));
    const text = reply.result.content[0].text;
    return reply.result.isError ? { error: text } : JSON.parse(text);
  };
  const inbox = async (token) =>
    (
      await fetch(`${base}/api/agent/inbox?wait=0`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
  const events = (token, body) =>
    fetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const names = (n) =>
    fake.issues.find((i) => i.number === n).labels.map((l) => l.name);
  const posted = (n) =>
    fake.writes
      .filter((w) => w.path === `/issues/${n}/comments`)
      .map((w) => w.body.body);
  try {
    await run({ tool, inbox, events, fake, clock, names, posted });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("chat names are chat or chat-<suffix>, within 31 characters", () => {
  for (const name of ["chat", "chat-macbook", "chat-2", "chat-luan-mac"])
    assert.equal(isChatAgent(name), true, name);
  for (const name of [
    "chatx",
    "chat-",
    "chat--x",
    "chat-MacBook",
    "chat_mac",
    "my-chat",
    `chat-${"a".repeat(27)}`,
    null,
  ])
    assert.equal(isChatAgent(name), false, String(name));
  assert.equal(chatAgent(""), "chat");
  assert.equal(chatAgent(undefined), "chat");
  assert.equal(chatAgent("macbook"), "chat-macbook");
  assert.equal(chatAgent("a".repeat(26)).length, 31);
  assert.throws(() => chatAgent("a".repeat(27)), /Tên chat không hợp lệ/);
  assert.throws(() => chatAgent("Mac Book"), /Tên chat không hợp lệ/);
});

test("no orchestrator may be called chat", () => {
  assert.throws(
    () => parseAgentTokens(`chat=${luan}`),
    /reserved for the owner's chat/,
  );
  assert.throws(
    () => parseAgentTokens(`chat-mac=${luan}`),
    /reserved for the owner's chat/,
  );
  assert.deepEqual(parseAgentTokens(`chatbot=${luan}`), { chatbot: luan });
  const manifest = {
    runtime: { orchestrator: "claude" },
    tracker: { kind: "github", repo: "a/b" },
  };
  const env = {
    BOARD_URL: "http://board:8080",
    AGENT_TOKEN: luan,
    GITHUB_TOKEN: "g",
  };
  for (const name of ["chat", "chat-mac"])
    assert.throws(
      () => configure(manifest, { ...env, AGENT_NAME: name }),
      /reserved for the owner's chat/,
    );
});

test("the chat claims a ready feature and gets the agent's prompt", () =>
  withBoard(async ({ tool, inbox, names, posted, fake }) => {
    // #2 is in plan: G2 first.
    assert.match(
      (await tool("claim_feature", { number: 2 })).error,
      /Chỉ nhận làm được feature ở cột Sẵn sàng.*Kế hoạch/,
    );
    await tool("decide", { number: 2, action: "approve" });
    // It was given to luan; the claim takes it away from luan at once.
    await tool("assign_agent", { number: 2, agent: "luan" });
    await inbox(luan);
    assert.match(
      (await tool("claim_feature", { number: 2, suffix: "Mac Book" })).error,
      /Tên chat không hợp lệ/,
    );
    const claimed = await tool("claim_feature", {
      number: 2,
      suffix: "macbook",
    });
    assert.equal(claimed.agent, "chat-macbook");
    assert.equal(claimed.before, "luan");
    assert.equal(claimed.stage, "running");
    assert.equal(claimed.staleHours, 24);
    // The agent's prompt, then the chat's own section (ADR-0010).
    const [agentPart, chatPart] = claimed.prompt.split(
      "\n## For the owner's chat (`chat-macbook`)\n",
    );
    assert.equal(
      agentPart,
      "\nImplement #2 So sánh hai báo cáo quỹ.\nFirst attempt.\n",
    );
    assert.match(chatPart, /Never add `symphony-ai-review`/);
    assert.match(chatPart, /add `symphony-human-review`/);
    assert.match(chatPart, /`get_pull_request`/);
    assert.match(chatPart, /merge with `decide approve`/);
    assert.match(chatPart, /If CI cannot pass, block the feature/);
    assert.match(chatPart, /`Closes #2`/);
    assert.deepEqual(
      names(2).sort(),
      [
        "agent:chat-macbook",
        "priority-now",
        labels.ready,
        labels.in_progress,
      ].sort(),
    );
    assert.deepEqual((await inbox(luan)).commands, [
      { type: "unassigned", issue: 2 },
    ]);
    const comment = posted(2).at(-1);
    assert.match(
      comment,
      /^\*\*Chat `chat-macbook` nhận làm\*\* \(AI của chủ dự án, qua MCP\)/,
    );
    assert.match(comment, /Closes #2/);
    assert.match(comment, /Trước đó là `luan`/);

    const feature = await tool("get_feature", { number: 2 });
    assert.equal(feature.stage, "running");
    assert.equal(feature.agent, "chat-macbook");
    assert.equal(feature.chat.name, "chat-macbook");
    assert.equal(feature.chat.stale, false);
    assert.equal(feature.session, null);

    // Running now, so it cannot be claimed again.
    assert.match(
      (await tool("claim_feature", { number: 2 })).error,
      /Đang làm/,
    );
    assert.equal(fake.issues.find((i) => i.number === 2).state, "open");
  }));

test("a claim without a suffix is plain chat, and needs WORKFLOW.md", () =>
  withBoard(async ({ tool, fake, names }) => {
    await tool("decide", { number: 2, action: "approve" });
    fake.repo.workflow = null;
    assert.match(
      (await tool("claim_feature", { number: 2 })).error,
      /Không đọc được WORKFLOW.md/,
    );
    // Nothing changed.
    assert.deepEqual(names(2).sort(), ["priority-now", labels.ready]);
    fake.repo.workflow = "---\na: 1\n---\nGo {{ issue.url }}\n";
    const claimed = await tool("claim_feature", { number: 2 });
    assert.equal(claimed.agent, "chat");
    assert.equal(claimed.before, null);
    assert.ok(
      claimed.prompt.startsWith(
        "Go https://github.com/example/demo-app/issues/2\n\n## For the owner's chat (`chat`)\n",
      ),
    );
    assert.ok(names(2).includes("agent:chat"));
  }));

test("a claim stops the unnamed orchestrator that had the feature", () =>
  withBoard(
    async ({ tool, inbox, events }) => {
      await tool("decide", { number: 2, action: "approve" });
      await events(solo, { states: [{ issue: 2, status: "running" }] });
      await tool("claim_feature", { number: 2 });
      assert.deepEqual((await inbox(solo)).commands, [
        { type: "unassigned", issue: 2 },
      ]);
    },
    { agentTokens: {}, agentToken: solo },
  ));

test("Symphony projects cannot hand a feature to the chat", () =>
  withBoard(
    async ({ tool }) => {
      await tool("decide", { number: 2, action: "approve" });
      assert.match(
        (await tool("claim_feature", { number: 2 })).error,
        /Symphony/,
      );
      assert.match(
        (await tool("assign_agent", { number: 2, agent: "chat" })).error,
        /Symphony/,
      );
    },
    { orchestrator: "symphony" },
  ));

test("assign_agent gives a feature to a chat without a token, and the chat has no session", () =>
  withBoard(
    async ({ tool, posted }) => {
      assert.match(
        (await tool("assign_agent", { number: 3, agent: "luan" })).error,
        /chưa có agent nào có tên/,
      );
      assert.match(
        (await tool("assign_agent", { number: 3, agent: "chat-" })).error,
        /chưa có agent nào có tên/,
      );
      const given = await tool("assign_agent", {
        number: 3,
        agent: "chat-mac",
      });
      assert.deepEqual(
        [given.agent, given.chat, given.changed],
        ["chat-mac", true, true],
      );
      assert.match(
        posted(3).at(-1),
        /^\*\*Giao cho chat `chat-mac` của chủ dự án\*\* \(AI của chủ dự án, qua MCP\)/,
      );

      const session = await tool("agent_session", { number: 3 });
      assert.deepEqual(
        [session.chat, session.agent, session.session],
        [true, "chat-mac", null],
      );
      assert.match(session.message, /không có phiên orchestrator/);
      for (const [name, args] of [
        ["message_agent", { text: "Hi" }],
        ["answer_agent", { id: "r1" }],
        ["control_agent", { mode: "takeover" }],
      ]) {
        const { error } = await tool(name, { number: 3, ...args });
        assert.match(error, /chat `chat-mac` của chủ dự án làm/, name);
        assert.doesNotMatch(error, /chưa được khai báo/, name);
      }
    },
    { agentTokens: {} },
  ));

test("a chat's feature can go back to a real agent, which is told nothing to stop", () =>
  withBoard(async ({ tool, inbox, posted }) => {
    await tool("assign_agent", { number: 3, agent: "chat" });
    await inbox(luan);
    const back = await tool("assign_agent", { number: 3, agent: "luan" });
    assert.deepEqual([back.before, back.chat], ["chat", false]);
    assert.match(posted(3).at(-1), /Trước đó là `chat`\. Agent mới/);
    assert.doesNotMatch(posted(3).at(-1), /phiên cũ/);
    assert.deepEqual((await inbox(luan)).commands, []);
    assert.equal((await tool("agent_session", { number: 3 })).chat, undefined);
  }));

test("the board warns when a running chat's workpad stands still", () =>
  withBoard(async ({ tool, clock, fake }) => {
    // #3 runs; its workpad is from 10:00, by the agent that had it before.
    fake.repo.now = new Date(at + 2 * hour).toISOString();
    await tool("assign_agent", { number: 3, agent: "chat-mac" });
    clock.now = at + 20 * hour;
    let board = await tool("board_overview", { fresh: true });
    const running = () =>
      board.columns.find((c) => c.id === "running").features[0];
    // The clock starts at the handover (12:00), not the old workpad.
    assert.deepEqual(running().chat, {
      name: "chat-mac",
      since: "2026-10-30T12:00:00.000Z",
      idleHours: 18,
      stale: false,
    });
    assert.equal(running().session, null);
    assert.equal(board.warnings, undefined);

    clock.now = at + 26 * hour + 1;
    board = await tool("board_overview", { fresh: true });
    assert.equal(running().chat.stale, true);
    assert.equal(running().chat.idleHours, 24);
    assert.match(running().chat.warning, /chưa cập nhật Agent Workpad 24 giờ/);
    assert.deepEqual(board.warnings, [`#3: ${running().chat.warning}`]);
    const feature = await tool("get_feature", { number: 3 });
    assert.equal(feature.chat.stale, true);

    // The chat edits its workpad: the warning goes.
    fake.comments[3][0].updated_at = new Date(at + 26 * hour).toISOString();
    board = await tool("board_overview", { fresh: true });
    assert.equal(running().chat.stale, false);
    assert.equal(board.warnings, undefined);
  }));

test("the stall threshold comes from runtime.chat.stale_hours", () =>
  withBoard(
    async ({ tool, clock }) => {
      await tool("assign_agent", { number: 3, agent: "chat" });
      clock.now = at + 2 * hour;
      const feature = await tool("get_feature", { number: 3 });
      assert.equal(feature.chat.stale, true);
      assert.match(feature.chat.warning, /ngưỡng 2 giờ/);
    },
    { staleHours: 2 },
  ));

test("the stall clock: workpad, else the claim; only while running", () => {
  const now = at + 30 * hour;
  const iso = (h) => new Date(at + h * hour).toISOString();
  const pad = (h) => ({
    body: "## Agent Workpad\n- [ ] x",
    workpad: true,
    created: iso(0),
    updated: iso(h),
  });
  const claim = (h) => ({
    body: "**Chat `chat` nhận làm** (AI của chủ dự án, qua MCP)",
    workpad: false,
    created: iso(h),
  });
  assert.equal(chatHold("chat", "running", [claim(1)], { now }).stale, true);
  assert.equal(chatHold("chat", "running", [claim(10)], { now }).stale, false);
  // A fresher workpad wins over an old claim, and the other way round.
  assert.equal(
    chatHold("chat", "running", [claim(1), pad(20)], { now }).since,
    iso(20),
  );
  assert.equal(
    chatHold("chat", "running", [pad(1), claim(20)], { now }).since,
    iso(20),
  );
  // Not running (in review, say), or nothing to count from: no warning.
  assert.deepEqual(chatHold("chat", "review", [claim(1)], { now }), {
    name: "chat",
    since: null,
    idleHours: null,
    stale: false,
  });
  assert.equal(chatHold("chat", "running", [], { now }).stale, false);
});

test("no orchestrator takes a chat's feature, and one that had it lets go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-"));
  try {
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
    // The AI reviewer (gates.merge: ai) hears only of this agent's features.
    const reviewed = [];
    const reviewer = {
      tick: async (issues) => reviewed.push(...issues.map((i) => i.number)),
    };
    const make = (agent) =>
      createController({
        gh,
        labels,
        store,
        runner,
        workspaces: { prepare: async (n) => `/ws/${n}` },
        workflowPrompt: parseWorkflow(fake.repo.workflow).prompt,
        agent,
        reviewer,
      });
    const issue = fake.issues.find((i) => i.number === 3);
    // #3 is ready and unlabelled: the unnamed orchestrator starts it, with
    // the plain WORKFLOW.md prompt and not the chat's section.
    await make("").tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Implement #3 Thêm biểu đồ dòng tiền/);
    assert.doesNotMatch(sent[0].text, /owner's chat|decide approve/);
    assert.ok(reviewed.includes(3));
    // The owner's chat takes it: the unnamed orchestrator lets go, and no
    // AI reviewer ever sees it, so the chat reviews and merges it itself.
    issue.labels.push({ name: "agent:chat-mac" });
    reviewed.length = 0;
    await make("").tick();
    assert.deepEqual(detached, [3]);
    for (const label of ["agent:chat", "agent:chat-mac"]) {
      issue.labels = issue.labels
        .filter((l) => !l.name.startsWith("agent:"))
        .concat({ name: label });
      for (const agent of ["", "luan", "chat", "chat-mac"])
        await make(agent).tick();
    }
    assert.equal(sent.length, 1);
    assert.ok(!reviewed.includes(3));
    await assert.rejects(
      make("").handle({ type: "message", issue: 3, text: "x" }),
      /assigned to chat/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the board image has every module the board imports", async () => {
  const dockerfile = await readFile(
    new URL("../board/Dockerfile", import.meta.url),
    "utf8",
  );
  const board = new URL("../board/", import.meta.url);
  for (const file of await readdir(board)) {
    if (!file.endsWith(".mjs")) continue;
    const text = await readFile(new URL(file, board), "utf8");
    for (const [, path] of text.matchAll(/from "\.\.\/([^"]+)"/g))
      assert.ok(
        dockerfile.includes(`COPY .project-os/${path} `),
        `board/Dockerfile must copy .project-os/${path} (imported by board/${file})`,
      );
  }
});
