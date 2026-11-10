// The board as an MCP server, so the owner's AI (Claude Code, say) can run the
// board for them: add ideas, write plans, pass the gates, review and merge pull
// requests, give features to agents and talk to their Claude sessions.
//
// Streamable HTTP, stateless: each POST /mcp carries one JSON-RPC message (or a
// batch) and gets a JSON answer, no SSE stream and no session id. The caller
// needs BOARD_MCP_TOKEN as a bearer token; the owner's cookie and the agents'
// tokens never work here, and this token never works anywhere else.
import { timingSafeEqual } from "node:crypto";
import {
  commentFeature,
  createIdea,
  loadFeatureDetails,
  loadPull,
  mcpActor,
  priorities,
  reviewEvents,
  reviewPull,
  updateFeature,
} from "./github.mjs";

export const protocolVersions = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const instructions = `This server runs a Project OS feature board. Features are GitHub issues; each moves through columns:
idea → (approve G1) → plan → (approve G2) → ready → running (an agent works on it) → review (a pull request waits) → (approve: squash-merge, close) → done. A feature can also be blocked.
Typical loop: board_overview to see what waits; get_feature for one feature (it lists the decisions its column allows); for an idea, write the plan into the body with update_feature, then decide approve; for a review, read get_pull_request (diff, checks), leave a review_pull_request or decide revise with a note, or decide approve to merge.
Every decision leaves a comment on the issue that names you as the owner's AI. Merging and stopping cannot be undone from here: check CI and the diff first.
A feature needs an agent (assign_agent) before it runs. Talk to its Claude session with message_agent, read it with agent_session, and answer its questions or approvals with answer_agent.
Write issue text, plans and notes in the language the project's issues already use.`;

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

const issueNumber = (value, name = "number") => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw fail(`${name} must be a positive integer`);
  return n;
};

const text = (value, name, max, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw fail(`${name} is required`);
    return undefined;
  }
  const out = String(value);
  if (required && !out.trim()) throw fail(`${name} is required`);
  if (out.length > max) throw fail(`${name} is longer than ${max} characters`);
  return out;
};

const oneOf = (value, name, allowed) => {
  if (value === undefined) return undefined;
  if (!allowed.includes(value))
    throw fail(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
};

const need = (value, name) => {
  if (value === undefined) throw fail(`${name} is required`);
  return value;
};

const number = { type: "integer", minimum: 1 };
const feature = { ...number, description: "The feature's issue number" };
const read = { readOnlyHint: true, openWorldHint: true };
const write = (destructive = false) => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  openWorldHint: true,
});

// The tools: a schema for the client and a handler that gets the checked
// arguments. `board` is the board's own context from server.mjs.
function toolList(board) {
  return [
    {
      name: "board_overview",
      title: "Board overview",
      description:
        "Every open feature by column (and the latest closed ones), with priority, agent, the agent's session status, pending agent requests and the linked pull request's CI and preview. Start here.",
      annotations: read,
      inputSchema: {
        type: "object",
        properties: {
          fresh: {
            type: "boolean",
            description: "Reload from GitHub instead of the 15-second cache",
          },
        },
      },
      run: async ({ fresh }) => compact(await board.overview(Boolean(fresh))),
    },
    {
      name: "get_feature",
      title: "Read a feature",
      description:
        "One feature in full: body (idea or plan), labels, stage, the decisions its column allows, every comment (the agent's workpad included), the linked pull request and the agent's session state.",
      annotations: read,
      inputSchema: {
        type: "object",
        properties: { number: feature },
        required: ["number"],
      },
      run: async (args) => {
        const n = issueNumber(args.number);
        const details = await loadFeatureDetails(board.github, board.labels, n);
        return { ...details, session: board.session(n)?.state ?? null };
      },
    },
    {
      name: "create_idea",
      title: "Add an idea",
      description:
        "Adds a feature in the idea column (a GitHub issue with the idea label). Put the problem, who it is for and what done looks like in the body.",
      annotations: write(),
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 200 },
          body: { type: "string", maxLength: 20000 },
          priority: { type: "string", enum: priorities },
        },
        required: ["title"],
      },
      run: async (args) => {
        const title = text(args.title, "title", 200, { required: true }).trim();
        const result = await createIdea(
          board.github,
          board.labels,
          title,
          text(args.body, "body", 20_000) ?? "",
          oneOf(args.priority, "priority", priorities),
        );
        board.invalidate();
        return result;
      },
    },
    {
      name: "update_feature",
      title: "Edit a feature",
      description:
        "Rewrites a feature's title or body (for example to write its plan before approving G2) and sets its priority. The body replaces the old one; read it first with get_feature. priority none removes it.",
      annotations: write(),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          title: { type: "string", maxLength: 200 },
          body: { type: "string", maxLength: 60000 },
          priority: { type: "string", enum: [...priorities, "none"] },
        },
        required: ["number"],
      },
      run: async (args) => {
        const title = text(args.title, "title", 200)?.trim();
        if (title === "") throw fail("title cannot be empty");
        const result = await updateFeature(
          board.github,
          issueNumber(args.number),
          {
            title,
            body: text(args.body, "body", 60_000),
            priority: oneOf(args.priority, "priority", [...priorities, "none"]),
          },
        );
        board.invalidate();
        return result;
      },
    },
    {
      name: "comment_feature",
      title: "Comment on a feature",
      description:
        "Adds a comment to the feature's issue: findings, a question for the agent, a note for the owner. It changes no labels.",
      annotations: write(),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          body: { type: "string", maxLength: 20000 },
        },
        required: ["number", "body"],
      },
      run: async (args) =>
        commentFeature(
          board.github,
          issueNumber(args.number),
          text(args.body, "body", 20_000, { required: true }),
        ),
    },
    {
      name: "decide",
      title: "Decide at a gate",
      description: `The board's buttons. What each action does depends on the column (get_feature lists the ones allowed):
- idea: approve → plan (G1); revise → comment asking for changes; stop → close as not planned.
- plan: approve → ready, so the agent starts (G2); revise; stop → close.
- ready / running: stop → pause (removes ready and in-progress).
- review: approve → squash-merge the linked pull request at its current head and close the feature (cannot be undone); revise → back to ready with your note, so the agent fixes it; stop → close, work dropped.
- blocked: approve → ready again; revise → ready with your note; stop → close.
revise needs a note. Every decision leaves a comment on the issue.`,
      annotations: write(true),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          action: { type: "string", enum: ["approve", "revise", "stop"] },
          note: { type: "string", maxLength: 5000 },
        },
        required: ["number", "action"],
      },
      run: async (args) => {
        const result = await board.decide(
          issueNumber(args.number),
          need(
            oneOf(args.action, "action", ["approve", "revise", "stop"]),
            "action",
          ),
          text(args.note, "note", 5000) ?? "",
        );
        return result;
      },
    },
    {
      name: "get_pull_request",
      title: "Read a pull request",
      description:
        "A pull request for review: description, author, branches, every check run, changed files and its diff. A diff over 60,000 characters comes in windows: call again with offset = nextOffset. Give the pull request number, or the feature number to find the one that closes it.",
      annotations: read,
      inputSchema: {
        type: "object",
        properties: {
          pull: { ...number, description: "Pull request number" },
          feature: {
            ...number,
            description: "Feature issue number, instead of pull",
          },
          offset: { type: "integer", minimum: 0 },
        },
      },
      run: async (args) => {
        let pull = args.pull;
        if (pull === undefined) {
          const n = issueNumber(args.feature, "feature");
          const details = await loadFeatureDetails(
            board.github,
            board.labels,
            n,
          );
          if (!details.pull)
            throw fail(`No pull request has "Closes #${n}"`, 404);
          pull = details.pull.number;
        }
        const offset = Number(args.offset ?? 0);
        if (!Number.isInteger(offset) || offset < 0)
          throw fail("offset must be 0 or more");
        return loadPull(board.github, issueNumber(pull, "pull"), { offset });
      },
    },
    {
      name: "review_pull_request",
      title: "Review a pull request",
      description:
        "Posts a review on the pull request at its current head. COMMENT leaves findings; REQUEST_CHANGES and APPROVE are GitHub's review states (GitHub refuses them from the account that opened the pull request; then use COMMENT, or decide revise on the feature). A review does not move the card: decide does.",
      annotations: write(),
      inputSchema: {
        type: "object",
        properties: {
          pull: { ...number, description: "Pull request number" },
          event: { type: "string", enum: reviewEvents },
          body: { type: "string", maxLength: 60000 },
        },
        required: ["pull", "event", "body"],
      },
      run: async (args) =>
        reviewPull(
          board.github,
          issueNumber(args.pull, "pull"),
          need(oneOf(args.event, "event", reviewEvents), "event"),
          text(args.body, "body", 60_000, { required: true }),
        ),
    },
    {
      name: "assign_agent",
      title: "Give a feature to an agent",
      description:
        "Gives the feature to a named Claude orchestrator (board_overview lists them and whether they are online). It replaces any other agent: the old one stops at once and the new one starts a fresh session from the issue and its workpad.",
      annotations: write(true),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          agent: { type: "string", maxLength: 31 },
        },
        required: ["number", "agent"],
      },
      run: async (args) =>
        board.assign(
          issueNumber(args.number),
          text(args.agent, "agent", 31, { required: true }),
        ),
    },
    {
      name: "agent_session",
      title: "Read an agent's session",
      description:
        "The live Claude session of a feature: its status, cost, the questions and approvals it waits on (with their ids, for answer_agent), its workspace and session id (to resume it with claude --resume in a terminal) and the latest events. Pass after = the previous cursor to get only new events.",
      annotations: read,
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          after: { type: "integer", minimum: 0 },
        },
        required: ["number"],
      },
      run: async (args) => {
        const view = board.session(
          issueNumber(args.number),
          Number(args.after) || 0,
        );
        if (!view)
          throw fail("The board is not linked to an orchestrator", 404);
        return view;
      },
    },
    {
      name: "message_agent",
      title: "Message an agent",
      description:
        "Sends a message to the feature's Claude session, as the owner would from the chat panel. The agent answers in agent_session.",
      annotations: write(),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          text: { type: "string", maxLength: 20000 },
        },
        required: ["number", "text"],
      },
      run: async (args) =>
        board.command(issueNumber(args.number), {
          type: "message",
          text: text(args.text, "text", 20_000, { required: true }).trim(),
        }),
    },
    {
      name: "answer_agent",
      title: "Answer an agent's request",
      description:
        "Answers one of the session's pending requests (agent_session lists them with their id). For an approval, allow true runs the tool and false refuses it, with an optional note. For a question, answers maps each question's text to the chosen option's label (or your own text).",
      annotations: write(true),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          id: { type: "string", maxLength: 64 },
          allow: { type: "boolean" },
          answers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          note: { type: "string", maxLength: 5000 },
        },
        required: ["number", "id"],
      },
      run: async (args) =>
        board.command(issueNumber(args.number), {
          type: "answer",
          id: text(args.id, "id", 64, { required: true }),
          allow: args.allow !== false,
          answers: Object.fromEntries(
            Object.entries(
              args.answers && typeof args.answers === "object"
                ? args.answers
                : {},
            )
              .slice(0, 4)
              .map(([q, a]) => [
                String(q).slice(0, 1000),
                String(a).slice(0, 5000),
              ]),
          ),
          note: text(args.note, "note", 5000) ?? "",
        }),
    },
    {
      name: "control_agent",
      title: "Take over or hand back a session",
      description:
        "takeover stops the feature's Claude session so a person can continue it in a terminal (agent_session shows its workspace and session id); release hands it back to the orchestrator.",
      annotations: write(true),
      inputSchema: {
        type: "object",
        properties: {
          number: feature,
          mode: { type: "string", enum: ["takeover", "release"] },
        },
        required: ["number", "mode"],
      },
      run: async (args) =>
        board.command(issueNumber(args.number), {
          type: need(oneOf(args.mode, "mode", ["takeover", "release"]), "mode"),
        }),
    },
  ];
}

// The board by column, without bodies: get_feature has those.
export function compact(data) {
  const sessions = data.agent?.features ?? {};
  return {
    project: data.project,
    repo: data.repo,
    loadedAt: data.loadedAt,
    agents: data.agent
      ? {
          named: data.agent.agents,
          unnamed: data.agent.unnamed,
        }
      : null,
    columns: data.columns.map((column) => ({
      id: column.id,
      title: column.title,
      gate: column.gate ?? null,
      features: data.features
        .filter((f) => f.stage === column.id)
        .map((f) => ({
          number: f.number,
          title: f.title,
          priority: f.priority,
          agent: f.agent,
          session: sessions[f.number] ?? null,
          comments: f.comments,
          updated: f.updated,
          summary: f.body.replace(/\s+/g, " ").trim().slice(0, 200),
          pull: f.pull,
        })),
    })),
  };
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

// Returns handle(request, response, readJson, send), or null without a token.
export function createMcp({ token, version = "0", board }) {
  if (!token) return null;
  const tools = toolList(board);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed = tools.map(({ run, ...tool }) => tool);

  async function call(name, args) {
    const tool = byName.get(name);
    try {
      const result = await tool.run(
        args && typeof args === "object" ? args : {},
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      // GitHub's own body never reaches here (github.mjs drops it).
      const message =
        error.status && error.message ? error.message : "The board failed";
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  async function answer(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
      return rpcError(null, -32600, "Invalid request");
    const { id, method, params = {} } = message;
    // A notification, or a response to a request we never send.
    if (id === undefined || id === null) return null;
    if (typeof method !== "string")
      return rpcError(id, -32600, "Invalid request");
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: protocolVersions.includes(params.protocolVersion)
            ? params.protocolVersion
            : protocolVersions[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "project-os-board",
            title: `${board.project} board`,
            version,
          },
          instructions,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: listed });
      case "tools/call":
        if (!byName.has(params.name))
          return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        return ok(await call(params.name, params.arguments));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async function handle(request, response, { readJson, send }) {
    // A browser page must not reach this (DNS rebinding); MCP clients send no
    // Origin.
    if (request.headers.origin)
      return send(response, 403, { error: "Origin not allowed" });
    if (!same(request.headers.authorization ?? "", `Bearer ${token}`))
      return send(
        response,
        401,
        { error: "Cần token" },
        { "WWW-Authenticate": 'Bearer realm="board-mcp"' },
      );
    if (request.method !== "POST")
      return send(response, 405, { error: "Use POST" }, { Allow: "POST" });
    if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
      return send(response, 415, rpcError(null, -32700, "Send JSON"));
    let body;
    try {
      body = await readJson(request, 512 * 1024);
    } catch (error) {
      if (error.status === 413) throw error;
      return send(response, 400, rpcError(null, -32700, "Parse error"));
    }
    const batch = Array.isArray(body);
    const replies = (
      await Promise.all((batch ? body : [body]).map(answer))
    ).filter(Boolean);
    if (!replies.length) {
      response.writeHead(202).end();
      return;
    }
    return send(response, 200, batch ? replies : replies[0]);
  };
}
