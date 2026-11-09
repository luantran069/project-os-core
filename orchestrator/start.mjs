import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHub } from "../board/github.mjs";
import {
  projectRoot,
  readProject,
  readWorkflow,
} from "../symphony/project.mjs";
import { createController } from "./controller.mjs";
import { runtimeNotes } from "./prompt.mjs";
import { createRelay } from "./relay.mjs";
import { createRunner } from "./runner.mjs";
import { createStore } from "./store.mjs";
import { createWorkspaces } from "./workspace.mjs";

export const hosts = ["mac", "dokploy"];
export const agentNamePattern = /^[a-z0-9][a-z0-9-]{0,30}$/;

// Never hand the board link's credentials to the agent.
const privateKeys = [
  "AGENT_TOKEN",
  "BOARD_URL",
  "BOARD_PASSWORD",
  "BOARD_SESSION_SECRET",
];

// Settings from project.yaml and the environment, checked before anything starts.
export function configure(manifest, env) {
  const runtime = manifest.runtime ?? {};
  const errors = [];
  if (runtime.orchestrator !== "claude")
    errors.push(
      'project.yaml runtime.orchestrator must be "claude" to use this orchestrator',
    );
  if (manifest.tracker?.kind !== "github")
    errors.push("The Claude orchestrator needs tracker.kind: github");
  // Where it runs belongs to the machine, not the repository: ORCHESTRATOR_HOST
  // wins over runtime.host, so one commit runs on the Mac or on Dokploy.
  const host = env.ORCHESTRATOR_HOST?.trim() || runtime.host || "mac";
  if (!hosts.includes(host))
    errors.push(
      `${env.ORCHESTRATOR_HOST?.trim() ? "ORCHESTRATOR_HOST" : "runtime.host"} must be one of ${hosts.join(", ")}`,
    );
  if (!env.BOARD_URL?.trim())
    errors.push("Set BOARD_URL to the board's address");
  else {
    const url = new URL(env.BOARD_URL);
    const local =
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.hostname.includes(".");
    if (url.protocol !== "https:" && !local)
      errors.push(
        "BOARD_URL must use https unless the board is local or on an internal network",
      );
  }
  if ((env.AGENT_TOKEN ?? "").length < 32)
    errors.push(
      "Set AGENT_TOKEN (at least 32 characters, the same value as the board's)",
    );
  if (!env.GITHUB_TOKEN?.trim()) errors.push("Set GITHUB_TOKEN");
  if (
    host === "dokploy" &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    !env.ANTHROPIC_API_KEY
  )
    errors.push(
      "On Dokploy set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY",
    );
  // With several agents on one board, each has a name and takes only the
  // features labelled agent:<name>. Without one it takes unlabelled features.
  const agent = env.AGENT_NAME?.trim() || "";
  if (agent && !agentNamePattern.test(agent))
    errors.push("AGENT_NAME may use a-z, 0-9 and dashes, up to 31 characters");
  if (errors.length) throw new Error(errors.join("\n"));
  const claude = runtime.claude ?? {};
  return {
    host,
    agent,
    repo: manifest.tracker.repo,
    labels: manifest.labels ?? {},
    maxConcurrent: Number(runtime.max_concurrent_agents ?? 1),
    maxTurns: Number(claude.max_turns ?? 200),
    model: claude.model ?? undefined,
    approvalTimeoutMs: Number(claude.approval_timeout_minutes ?? 30) * 60_000,
    pollMs: Number(claude.poll_seconds ?? 30) * 1000,
    agentEnv: Object.fromEntries(
      Object.entries(env).filter(([key]) => !privateKeys.includes(key)),
    ),
  };
}

export async function main(env = process.env) {
  const root = projectRoot();
  const settings = configure(await readProject(root), env);
  const workflow = await readWorkflow(root);
  let sdk;
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error(
      "Install the Claude Agent SDK in the project: npm install @anthropic-ai/claude-agent-sdk",
    );
  }
  const stateDir = resolve(root, env.ORCHESTRATOR_STATE ?? ".orchestrator");
  const store = createStore(stateDir);
  store.recover();
  const relay = createRelay({
    boardUrl: env.BOARD_URL,
    token: env.AGENT_TOKEN,
    agent: settings.agent,
  });
  const emit = (issue, event, state) =>
    relay.emit(issue, event, state && { ...state, host: settings.host });
  const runner = createRunner({
    query: sdk.query,
    store,
    emit,
    systemAppend: runtimeNotes(settings),
    maxConcurrent: settings.maxConcurrent,
    maxTurns: settings.maxTurns,
    approvalTimeoutMs: settings.approvalTimeoutMs,
    model: settings.model,
    env: settings.agentEnv,
  });
  const gh = createGitHub({
    repo: settings.repo,
    token: env.GITHUB_TOKEN.trim(),
  });
  const controller = createController({
    gh,
    labels: settings.labels,
    store,
    runner,
    workspaces: createWorkspaces({
      root: join(stateDir, "workspaces"),
      hooks: workflow.config?.hooks,
    }),
    workflowPrompt: workflow.prompt,
    agent: settings.agent,
  });

  // Tell the board what exists, then keep telling it so it knows we are alive.
  // Features that moved to another agent are left out: the board shows theirs.
  const announce = () => {
    const own = store.list().filter((r) => r.status !== "reassigned");
    for (const record of own)
      emit(record.issue, { kind: "heartbeat" }, runner.snapshot(record.issue));
    if (!own.length) relay.emit(0, { kind: "heartbeat" });
  };
  announce();
  const heartbeat = setInterval(announce, 30_000);
  const tick = () =>
    controller
      .tick()
      .catch((error) =>
        console.error(
          `Orchestrator could not read the tracker: ${error.message}`,
        ),
      );
  await tick();
  const poller = setInterval(tick, settings.pollMs);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      clearInterval(poller);
      clearInterval(heartbeat);
      relay.stop();
      runner.stopAll();
      setTimeout(() => process.exit(0), 1000).unref();
    });
  console.log(
    `Claude orchestrator${settings.agent ? ` "${settings.agent}"` : ""} for ${settings.repo} on ${settings.host}, board ${new URL(env.BOARD_URL).origin}`,
  );
  try {
    await relay.listen((command) => controller.handle(command));
  } finally {
    clearInterval(poller);
    clearInterval(heartbeat);
    runner.stopAll();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`Orchestrator cannot start:\n${error.message}`);
    process.exitCode = 1;
  });
