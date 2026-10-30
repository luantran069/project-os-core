import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  archiveCommand,
  codexCommand,
  projectRoot,
  readProject,
  readWorkflow,
} from "./project.mjs";

const requiredPermissions = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "ADD_COMMENTS",
  "TRANSITION_ISSUES",
];
const normalized = (value) => value.trim().toLowerCase();
const jqlString = (value) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// Read-only authentication, project/workflow/permission checks and the pinned
// v0.0.3 candidate-search contract. Never echo Jira response bodies or secrets.
export async function checkJira(
  config,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const settings = {};
  for (const key of ["base_url", "email", "api_token"]) {
    const variable = config.tracker.provider[key].slice(1);
    assert.ok(
      env[variable]?.trim(),
      `Missing ${variable}; provide it on the Symphony host`,
    );
    settings[key] = env[variable].trim();
  }
  let base;
  try {
    base = new URL(settings.base_url);
  } catch {
    throw new Error("JIRA_BASE_URL must be a valid HTTPS Jira base URL");
  }
  assert.equal(base.protocol, "https:", "Jira Cloud needs an HTTPS base URL");
  assert.ok(
    !base.username && !base.password && !base.search && !base.hash,
    "Jira base URL must not contain credentials, a query, or a fragment",
  );
  const prefix = base.href.replace(/\/$/, "");
  const authorization = `Basic ${Buffer.from(`${settings.email}:${settings.api_token}`).toString("base64")}`;
  async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${prefix}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        `Jira preflight ${method} ${path.split("?")[0]} could not connect; check host/network access`,
      );
    }
    assert.ok(
      response.ok,
      `Jira preflight ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`,
    );
    try {
      return await response.json();
    } catch {
      throw new Error(
        `Jira preflight ${path.split("?")[0]} returned invalid JSON`,
      );
    }
  }
  const key = config.tracker.provider.project_key;
  const projectPath = `/rest/api/3/project/${encodeURIComponent(key)}`;
  const permissionQuery = new URLSearchParams({
    projectKey: key,
    permissions: requiredPermissions.join(","),
  });
  // Match the pinned runtime's search; the scheduler applies labels afterward.
  const jql = `project = ${jqlString(key)} AND status IN (${config.tracker.active_states.map(jqlString).join(", ")})`;
  const [self, project, issueTypes, permissionResult, search] =
    await Promise.all([
      request("/rest/api/3/myself"),
      request(projectPath),
      request(`${projectPath}/statuses`),
      request(`/rest/api/3/mypermissions?${permissionQuery}`),
      request("/rest/api/3/search/jql", {
        method: "POST",
        body: {
          jql,
          fields: [
            "summary",
            "description",
            "status",
            "labels",
            "assignee",
            "created",
            "updated",
            "project",
            "issuelinks",
          ],
          maxResults: 100,
        },
      }),
    ]);
  assert.ok(
    self.accountId && self.active !== false,
    "Jira account is not active or authentication is incomplete",
  );
  assert.equal(
    normalized(project.key),
    normalized(key),
    "Jira returned a different project",
  );
  assert.ok(
    Array.isArray(issueTypes),
    "Jira project statuses response is invalid",
  );
  const states = issueTypes.flatMap((type) => type.statuses ?? []);
  for (const name of [
    ...config.tracker.active_states,
    ...config.tracker.terminal_states,
    "Impact",
  ]) {
    assert.ok(
      states.some((state) => normalized(state.name) === normalized(name)),
      `Configured state '${name}' does not exist in the Jira project`,
    );
  }
  assert.ok(
    states.some(
      (state) =>
        normalized(state.name) === "ready for delivery" &&
        state.statusCategory?.key === "new",
    ),
    "Ready for delivery must use Jira's new category for dependency gating",
  );
  assert.ok(
    states.some(
      (state) =>
        normalized(state.name) === "done" &&
        state.statusCategory?.key === "done",
    ),
    "Done must use Jira's done category",
  );
  for (const permission of requiredPermissions) {
    assert.equal(
      permissionResult.permissions?.[permission]?.havePermission,
      true,
      `Jira project permission missing: ${permission}`,
    );
  }
  assert.ok(
    Array.isArray(search.issues),
    "Jira candidate polling returned an invalid issue list",
  );
  assert.ok(
    search.isLast === true ||
      (search.isLast === false &&
        typeof search.nextPageToken === "string" &&
        search.nextPageToken !== ""),
    "Jira candidate polling returned invalid pagination markers",
  );
  return {
    projectKey: key,
    permissions: requiredPermissions.length,
    polled: search.issues.length,
    eligible: search.issues.filter((issue) =>
      config.tracker.required_labels.every((label) =>
        (issue.fields?.labels ?? []).some(
          (item) => normalized(item) === normalized(label),
        ),
      ),
    ).length,
  };
}

// Checks WORKFLOW.md against the Project OS workflow contract and the project's
// own values in project.yaml. Core conventions (state names, the launcher and
// archive commands, loopback monitoring) are fixed; the rest comes from the manifest.
export async function checkWorkflow(live = false, root = projectRoot()) {
  const project = await readProject(root);
  const { config, prompt } = await readWorkflow(root);
  const labels = project.labels ?? {};
  const runtime = project.runtime ?? {};
  assert.equal(config.tracker.kind, "jira");
  assert.ok(
    config.tracker.required_labels.includes(labels.ready),
    `required_labels must include the ready label "${labels.ready}"`,
  );
  assert.deepEqual(config.tracker.active_states, [
    "Ready for delivery",
    "Delivery",
  ]);
  assert.deepEqual(config.tracker.terminal_states, ["Done"]);
  assert.equal(
    config.tracker.provider.project_key,
    project.tracker?.project_key,
    "WORKFLOW.md project_key must match project.yaml tracker.project_key",
  );
  assert.equal(
    config.agent.max_concurrent_agents,
    runtime.max_concurrent_agents,
    "max_concurrent_agents must match project.yaml runtime",
  );
  assert.equal(
    config.agent.max_turns,
    runtime.max_turns,
    "max_turns must match project.yaml runtime",
  );
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.codex.command, codexCommand);
  assert.equal(config.codex.approval_policy, "never");
  assert.equal(config.codex.thread_sandbox, "workspace-write");
  assert.equal(config.codex.turn_sandbox_policy.networkAccess, true);
  for (const key of ["base_url", "email", "api_token"])
    assert.match(
      config.tracker.provider[key],
      /^\$[A-Z_]+$/,
      `Use environment references for ${key}`,
    );
  assert.ok(config.hooks.after_create.includes("git clone"));
  if (runtime.setup_command)
    assert.ok(
      config.hooks.after_create.includes(runtime.setup_command),
      `after_create must run ${runtime.setup_command}`,
    );
  assert.equal(config.hooks.before_remove.trim(), archiveCommand);
  for (const phrase of [
    "{{ issue.identifier }}",
    "Agent Workpad",
    "Impact",
    labels.blocked,
    labels.pilot_review,
    "match-head-commit",
    ...(runtime.verify_command ? [runtime.verify_command] : []),
  ])
    assert.ok(prompt.includes(phrase), `Missing workflow contract: ${phrase}`);
  let jira;
  if (live) {
    await access(join(root, ".symphony/bin/symphony"), constants.X_OK);
    jira = await checkJira(config);
  }
  return { ...(jira ? { jira } : {}) };
}

export async function main() {
  try {
    const result = await checkWorkflow(process.argv.includes("--live"));
    console.log(
      result.jira
        ? `Workflow and live Jira verified: ${result.jira.projectKey}, ${result.jira.permissions} required permissions, ${result.jira.polled} polled issues (${result.jira.eligible} labelled candidates on first page). No Jira content changed.`
        : "Workflow structure verified; live Jira and task execution require separate checks.",
    );
  } catch (error) {
    console.error(`Symphony preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
