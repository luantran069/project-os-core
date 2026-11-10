import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createGitHub } from "../board/github.mjs";
import { createBoard } from "../board/server.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const mcpToken = "m".repeat(40);
const luan = "l".repeat(40);
const password = "correct horse battery";

async function withMcp(run, extra = {}) {
  const fake = fakeGitHub();
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password,
    secure: false,
    mcpToken,
    version: "9.9.9",
    agentTokens: { luan },
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
  const post = (body, headers = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  let id = 0;
  const rpc = async (method, params) =>
    (await post({ jsonrpc: "2.0", id: ++id, method, params })).json();
  // A tool's JSON result, or its error text when isError is set.
  const tool = async (name, args = {}) => {
    const reply = await rpc("tools/call", { name, arguments: args });
    assert.ok(reply.result, JSON.stringify(reply));
    const text = reply.result.content[0].text;
    return reply.result.isError ? { error: text } : JSON.parse(text);
  };
  const inbox = async () =>
    (
      await fetch(`${base}/api/agent/inbox?wait=0`, {
        headers: { Authorization: `Bearer ${luan}` },
      })
    ).json();
  try {
    await run({ base, post, rpc, tool, inbox, fake });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("without BOARD_MCP_TOKEN there is no MCP endpoint", () =>
  withMcp(
    async ({ post }) => {
      assert.equal((await post({})).status, 404);
    },
    { mcpToken: "" },
  ));

test("only the MCP token opens the endpoint, never from a browser page", () =>
  withMcp(async ({ base, post }) => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    assert.equal((await post(ping)).status, 200);
    const none = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ping),
    });
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate"), /Bearer/);
    // An agent's token is for the inbox, not for running the board.
    const agent = await post(ping, { Authorization: `Bearer ${luan}` });
    assert.equal(agent.status, 401);
    const page = await post(ping, { Origin: "https://evil.example" });
    assert.equal(page.status, 403);
    // And the MCP token opens no owner route.
    const owner = await fetch(`${base}/api/board`, {
      headers: { Authorization: `Bearer ${mcpToken}` },
    });
    assert.equal(owner.status, 401);
    const get = await fetch(`${base}/mcp`, {
      headers: { Authorization: `Bearer ${mcpToken}` },
    });
    assert.equal(get.status, 405);
  }));

test("a client initializes, lists the tools and gets JSON-RPC errors", () =>
  withMcp(async ({ post, rpc }) => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.serverInfo, {
      name: "project-os-board",
      title: "Demo board",
      version: "9.9.9",
    });
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /idea → \(approve G1\) → plan/);
    const unknownVersion = await rpc("initialize", { protocolVersion: "1999" });
    assert.equal(unknownVersion.result.protocolVersion, "2025-06-18");

    const note = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(note.status, 202);

    const { tools } = (await rpc("tools/list")).result;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "agent_session",
      "answer_agent",
      "assign_agent",
      "board_overview",
      "claim_feature",
      "comment_feature",
      "control_agent",
      "create_idea",
      "decide",
      "get_feature",
      "get_pull_request",
      "message_agent",
      "review_pull_request",
      "update_feature",
    ]);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.run, undefined);
    }
    assert.equal(
      tools.find((t) => t.name === "decide").annotations.destructiveHint,
      true,
    );

    assert.equal((await rpc("nope")).error.code, -32601);
    assert.equal(
      (await rpc("tools/call", { name: "nope" })).error.code,
      -32602,
    );
    const batch = await (
      await post([
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ])
    ).json();
    assert.deepEqual(batch, [{ jsonrpc: "2.0", id: "a", result: {} }]);
  }));

test("the overview groups features by column without their bodies", () =>
  withMcp(async ({ tool }) => {
    const board = await tool("board_overview");
    assert.equal(board.project, "Demo");
    const column = (id) => board.columns.find((c) => c.id === id);
    assert.deepEqual(
      column("plan").features.map((f) => [f.number, f.priority]),
      [[2, "now"]],
    );
    assert.equal(
      column("plan").features[0].summary,
      "## Kế hoạch - [ ] Bảng so sánh - [ ] Xuất CSV",
    );
    assert.equal(column("review").features[0].pull.number, 40);
    assert.equal(column("review").features[0].pull.checks, "success");
    assert.deepEqual(board.agents.named, [{ name: "luan", online: false }]);
  }));

test("the AI turns an idea into a plan and passes G1 and G2", () =>
  withMcp(async ({ tool, fake }) => {
    const idea = await tool("create_idea", {
      title: "Xuất báo cáo PDF",
      body: "Người dùng cần gửi báo cáo cho kế toán.",
      priority: "next",
    });
    const issue = fake.issues.find((i) => i.number === idea.number);
    assert.deepEqual(
      issue.labels.map((l) => l.name),
      [labels.idea, "priority-next"],
    );
    assert.match(
      (await tool("create_idea", { title: "  " })).error,
      /title is required/,
    );

    const feature = await tool("get_feature", { number: idea.number });
    assert.equal(feature.stage, "idea");
    assert.deepEqual(
      feature.actions.map((a) => a.action),
      ["approve", "revise", "stop"],
    );

    await tool("decide", { number: idea.number, action: "approve" });
    assert.ok(issue.labels.some((l) => l.name === labels.plan));
    const audit = fake.writes.find(
      (w) => w.path === `/issues/${idea.number}/comments`,
    );
    assert.match(audit.body.body, /Duyệt G1.*AI của chủ dự án, qua MCP/);

    await tool("update_feature", {
      number: idea.number,
      body: "## Kế hoạch\n- [ ] Nút xuất PDF",
      priority: "now",
    });
    assert.equal(issue.body, "## Kế hoạch\n- [ ] Nút xuất PDF");
    assert.deepEqual(
      issue.labels.map((l) => l.name).sort(),
      [labels.plan, "priority-now"].sort(),
    );
    await tool("update_feature", { number: idea.number, priority: "none" });
    assert.deepEqual(
      issue.labels.map((l) => l.name),
      [labels.plan],
    );

    await tool("decide", { number: idea.number, action: "approve" });
    assert.deepEqual(
      issue.labels.map((l) => l.name),
      [labels.ready],
    );
    // The column allows nothing but a pause now.
    assert.match(
      (await tool("decide", { number: idea.number, action: "approve" })).error,
      /Không làm được/,
    );
    assert.match(
      (await tool("decide", { number: idea.number, action: "jump" })).error,
      /action must be one of/,
    );
  }));

test("the AI reviews a pull request and merges it at its head", () =>
  withMcp(async ({ tool, fake }) => {
    const first = await tool("get_pull_request", { feature: 4 });
    assert.equal(first.number, 40);
    assert.equal(first.author, "agent-bot");
    assert.deepEqual(first.closes, [4]);
    assert.deepEqual(first.files, [
      {
        path: "web/src/Detail.tsx",
        status: "added",
        additions: 3,
        deletions: 0,
      },
    ]);
    assert.equal(first.checkRuns[0].conclusion, "success");
    assert.equal(first.diff.length, 60_000);
    assert.equal(first.diffLength, fake.diffs[40].length);
    const rest = await tool("get_pull_request", {
      pull: 40,
      offset: first.nextOffset,
    });
    assert.equal(rest.nextOffset, null);
    assert.equal(first.diff + rest.diff, fake.diffs[40]);
    assert.match(
      (await tool("get_pull_request", { feature: 1 })).error,
      /No pull request has "Closes #1"/,
    );

    const review = await tool("review_pull_request", {
      pull: 40,
      event: "COMMENT",
      body: "Thiếu test cho trang trống.",
    });
    assert.match(review.url, /pull\/40#review/);
    assert.deepEqual(
      fake.writes.find((w) => w.path === "/pulls/40/reviews").body,
      {
        event: "COMMENT",
        body: "Thiếu test cho trang trống.",
        commit_id: "abc",
      },
    );

    assert.match(
      (await tool("decide", { number: 4, action: "revise" })).error,
      /Cần ghi chú/,
    );
    const merged = await tool("decide", { number: 4, action: "approve" });
    assert.deepEqual(merged.merged, { number: 40, sha: "merged" });
    const issue = fake.issues.find((i) => i.number === 4);
    assert.equal(issue.state, "closed");
  }));

test("the AI gives a feature to an agent and talks to its session", () =>
  withMcp(async ({ tool, inbox, fake }) => {
    assert.match(
      (await tool("message_agent", { number: 3, text: "Hi" })).error,
      /chưa được giao/,
    );
    assert.match(
      (await tool("assign_agent", { number: 3, agent: "nobody" })).error,
      /Không có agent này/,
    );
    const given = await tool("assign_agent", { number: 3, agent: "luan" });
    assert.deepEqual([given.agent, given.changed], ["luan", true]);
    assert.ok(
      fake.writes.some(
        (w) =>
          w.path === "/issues/3/comments" &&
          /Giao cho agent `luan`\*\* \(AI của chủ dự án, qua MCP\)/.test(
            w.body.body,
          ),
      ),
    );

    await tool("message_agent", { number: 3, text: "Chạy lại test" });
    await tool("answer_agent", {
      number: 3,
      id: "req-1",
      allow: false,
      note: "Không xoá thư mục đó",
    });
    await tool("control_agent", { number: 3, mode: "takeover" });
    assert.deepEqual((await inbox()).commands, [
      { type: "message", issue: 3, text: "Chạy lại test" },
      {
        type: "answer",
        issue: 3,
        id: "req-1",
        allow: false,
        answers: {},
        note: "Không xoá thư mục đó",
      },
      { type: "takeover", issue: 3 },
    ]);

    const session = await tool("agent_session", { number: 3 });
    assert.equal(session.online, true);
    assert.deepEqual(
      session.events.map((e) => [e.kind, e.text]),
      [["owner", "Chạy lại test"]],
    );
    const later = await tool("agent_session", {
      number: 3,
      after: session.cursor,
    });
    assert.deepEqual(later.events, []);
  }));
