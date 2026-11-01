import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { codexCommand, projectRoot, readWorkflow } from "./project.mjs";

const root = projectRoot();

// Match send_initialize in the pinned v0.0.3 runtime:
// https://github.com/openai/symphony/blob/v0.0.3/elixir/lib/symphony_elixir/codex/app_server.ex
const initialize = {
  capabilities: { experimentalApi: true },
  clientInfo: {
    name: "symphony-orchestrator",
    title: "Symphony Orchestrator",
    version: "0.1.0",
  },
};

// Keep this untagged tool specification identical to Jira.AgentTool.tool_specs/0
// in v0.0.3. Schema generation alone can differ from accepted wire payloads.
const jiraRest = {
  name: "jira_rest",
  description:
    "Execute a Jira Cloud REST v3 request using Symphony's configured auth.\n",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["method", "path"],
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE"],
        description: "Jira REST method.",
      },
      path: {
        type: "string",
        description: "Jira REST v3 path beginning with /rest/api/3/.",
      },
      query: {
        type: ["object", "null"],
        description: "Optional query parameters.",
        additionalProperties: true,
      },
      body: { description: "Optional JSON request body." },
    },
  },
};

// Same for GitHub.AgentTool.tool_specs/0 in v0.0.3.
const githubApi = {
  name: "github_api",
  description:
    "Execute a GitHub REST API request using Symphony's configured auth.\n",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["method", "path"],
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
        description: "GitHub REST method.",
      },
      path: {
        type: "string",
        description:
          "GitHub REST path such as /repos/owner/repo/issues/1/comments.",
      },
      params: {
        type: ["object", "null"],
        description: "Optional query parameters.",
        additionalProperties: true,
      },
      body: { description: "Optional JSON request body." },
    },
  },
};
const trackerTools = { jira: jiraRest, github: githubApi };

let child;
let lines;
let timeout;
let closed;
const pending = new Map();
function fail(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  const manifest = JSON.parse(
    await readFile(new URL("runtime.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.version,
    "v0.0.3",
    "Review the probe payload when upgrading Symphony",
  );
  const { config } = await readWorkflow(root);
  assert.equal(config.codex.command, codexCommand);
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("codex.mjs", import.meta.url))],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  closed = new Promise((resolve) => child.once("close", resolve));
  child.on("error", () =>
    fail(
      new Error(
        "Cannot launch codex app-server; check the worker host's Codex installation",
      ),
    ),
  );
  child.stdin.on("error", () =>
    fail(new Error("Codex App Server closed its input stream")),
  );
  child.on("close", () =>
    fail(new Error("Codex App Server exited before the probe completed")),
  );
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error("Codex App Server returned invalid protocol JSON"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(new Error("Codex App Server returned an invalid protocol message"));
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(
        new Error(
          `Codex rejected ${waiter.method} (code ${message.error.code})`,
        ),
      );
    else if (Object.hasOwn(message, "result")) waiter.resolve(message.result);
    else
      waiter.reject(
        new Error("Codex returned a response without result or error"),
      );
  });
  timeout = setTimeout(
    () => fail(new Error("Codex App Server probe timed out after 15 seconds")),
    15_000,
  );
  const result = await request(1, "initialize", initialize);
  assert.ok(
    result && typeof result === "object",
    "Missing initialization result",
  );
  child.stdin.write(
    `${JSON.stringify({ method: "initialized", params: {} })}\n`,
  );
  const loaded = await request(2, "thread/loaded/list", {});
  assert.ok(Array.isArray(loaded.data), "Invalid loaded-thread list response");
  // v0.0.3's omitted policy is incompatible with some newer Codex releases.
  // Test the real thread/start contract, rather than stopping at initialize.
  const kind = config.tracker?.kind ?? "jira";
  const tool = trackerTools[kind];
  assert.ok(tool, `Unsupported tracker kind: ${kind}`);
  const approvalPolicy = config.codex.approval_policy ?? {
    reject: {
      sandbox_approval: true,
      rules: true,
      mcp_elicitations: true,
    },
  };
  const started = await request(3, "thread/start", {
    approvalPolicy,
    sandbox: config.codex.thread_sandbox ?? "workspace-write",
    cwd: root,
    dynamicTools: [tool],
    ephemeral: true,
  });
  assert.ok(started?.thread?.id, "Missing ephemeral thread ID");
  assert.deepEqual(started.approvalPolicy, approvalPolicy);
  assert.equal(started.sandbox?.type, "workspaceWrite");
  console.log(
    `Codex stdio probe passed: pinned initialization, loaded-thread listing, and an ephemeral thread with the configured approval policy, workspace-write sandbox and pinned ${tool.name} tool were accepted. No model turn or tracker request was made; dispatch and task execution remain unverified.`,
  );
} catch (error) {
  console.error(`Codex stdio probe failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  lines?.close();
  if (child) {
    child.stdin.end();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(force);
  }
}
