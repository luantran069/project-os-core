import { test } from "node:test";
import assert from "node:assert/strict";

const { checkJira } = await import(
  new URL("../symphony/check.mjs", import.meta.url).href
);
const config = {
  tracker: {
    provider: {
      base_url: "$JIRA_BASE_URL",
      email: "$JIRA_EMAIL",
      api_token: "$JIRA_API_TOKEN",
      project_key: "IS",
    },
    active_states: ["Ready for delivery", "Delivery"],
    terminal_states: ["Done"],
    required_labels: ["symphony-ready"],
  },
};
const env = {
  JIRA_BASE_URL: "https://jira.example",
  JIRA_EMAIL: "fixture@example.com",
  JIRA_API_TOKEN: "private-fixture-token",
};
const permissions = Object.fromEntries(
  [
    "BROWSE_PROJECTS",
    "CREATE_ISSUES",
    "EDIT_ISSUES",
    "ADD_COMMENTS",
    "TRANSITION_ISSUES",
  ].map((name) => [name, { havePermission: true }]),
);
const states = [
  { name: "Ready for delivery", statusCategory: { key: "new" } },
  { name: "Delivery", statusCategory: { key: "indeterminate" } },
  { name: "Impact", statusCategory: { key: "indeterminate" } },
  { name: "Done", statusCategory: { key: "done" } },
];
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}`,
    );
    const payloads: Record<string, unknown> = {
      "/rest/api/3/myself": { accountId: "fixture", active: true },
      "/rest/api/3/project/IS": { key: "IS" },
      "/rest/api/3/project/IS/statuses": [{ statuses: states }],
      "/rest/api/3/mypermissions": { permissions },
      "/rest/api/3/search/jql": {
        isLast: true,
        issues: [
          { fields: { labels: ["SYMPHONY-READY"] } },
          { fields: { labels: ["symphony-idea"] } },
        ],
      },
      ...overrides,
    };
    assert.ok(
      Object.hasOwn(payloads, url.pathname),
      "Only expected read-only APIs may run",
    );
    return Response.json(payloads[url.pathname]);
  };
  return { calls, fetchImpl };
}

test("Jira preflight checks permissions/states and uses the actual v0.0.3 polling contract without writes", async () => {
  const mock = fixture();
  assert.deepEqual(
    await checkJira(config, { env, fetchImpl: mock.fetchImpl }),
    { projectKey: "IS", permissions: 5, polled: 2, eligible: 1 },
  );
  assert.equal(mock.calls.length, 5);
  const search = mock.calls.find(({ url }) =>
    url.pathname.endsWith("search/jql"),
  );
  assert.equal(search?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(search?.init?.body)), {
    jql: 'project = "IS" AND status IN ("Ready for delivery", "Delivery")',
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
  });
  const queried = mock.calls.find(({ url }) =>
    url.pathname.endsWith("mypermissions"),
  );
  assert.equal(queried?.url.searchParams.get("projectKey"), "IS");
  assert.equal(
    queried?.url.searchParams.get("permissions")?.split(",").length,
    5,
  );
});

test("Jira preflight rejects missing permission and unavailable review status", async () => {
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: fixture({
        "/rest/api/3/mypermissions": {
          permissions: {
            ...permissions,
            TRANSITION_ISSUES: { havePermission: false },
          },
        },
      }).fetchImpl,
    }),
    /permission missing: TRANSITION_ISSUES/,
  );
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: fixture({
        "/rest/api/3/project/IS/statuses": [
          { statuses: states.filter((state) => state.name !== "Impact") },
        ],
      }).fetchImpl,
    }),
    /Impact.*does not exist/,
  );
});

test("Jira preflight rejects incorrect dependency category and another project", async () => {
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: fixture({
        "/rest/api/3/project/IS/statuses": [
          {
            statuses: states.map((state) =>
              state.name === "Ready for delivery"
                ? { ...state, statusCategory: { key: "indeterminate" } }
                : state,
            ),
          },
        ],
      }).fetchImpl,
    }),
    /new category for dependency gating/,
  );
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: fixture({ "/rest/api/3/project/IS": { key: "OTHER" } })
        .fetchImpl,
    }),
    /different project/,
  );
});

test("Jira preflight validates configuration before sending credentials", async () => {
  const fetchImpl = async () => {
    assert.fail("Invalid configuration must not make a request");
  };
  await assert.rejects(
    checkJira(config, { env: { ...env, JIRA_API_TOKEN: "" }, fetchImpl }),
    /Missing JIRA_API_TOKEN/,
  );
  await assert.rejects(
    checkJira(config, {
      env: { ...env, JIRA_BASE_URL: "https://secret:token@jira.example" },
      fetchImpl,
    }),
    /must not contain credentials/,
  );
  await assert.rejects(
    checkJira(config, {
      env: { ...env, JIRA_BASE_URL: "http://jira.example" },
      fetchImpl,
    }),
    /HTTPS/,
  );
});

test("Jira preflight errors never expose upstream bodies, credentials, or connection error text", async () => {
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: async () => new Response(env.JIRA_API_TOKEN, { status: 401 }),
    }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes(env.JIRA_API_TOKEN));
      return true;
    },
  );
  await assert.rejects(
    checkJira(config, {
      env,
      fetchImpl: async () => {
        throw new Error(env.JIRA_API_TOKEN);
      },
    }),
    (error: Error) => {
      assert.match(error.message, /could not connect/);
      assert.ok(!error.message.includes(env.JIRA_API_TOKEN));
      return true;
    },
  );
});

test("Jira preflight accepts usable page markers and rejects runtime-incompatible pagination", async () => {
  const paged = fixture({
    "/rest/api/3/search/jql": {
      issues: [],
      isLast: false,
      nextPageToken: "fixture-page",
    },
  });
  assert.equal(
    (await checkJira(config, { env, fetchImpl: paged.fetchImpl })).polled,
    0,
  );
  for (const page of [
    { issues: [] },
    { issues: [], isLast: false },
    { issues: [], isLast: false, nextPageToken: "" },
    { issues: [], isLast: false, nextPageToken: 1 },
    { issues: [], isLast: "true" },
  ]) {
    await assert.rejects(
      checkJira(config, {
        env,
        fetchImpl: fixture({ "/rest/api/3/search/jql": page }).fetchImpl,
      }),
      /invalid pagination markers/,
    );
  }
});

const { checkGitHub } = await import(
  new URL("../symphony/check.mjs", import.meta.url).href
);
const githubConfig = {
  tracker: {
    kind: "github",
    provider: { repo: "example/demo-app", token: "$GITHUB_TOKEN" },
    active_states: ["open"],
    terminal_states: ["closed"],
    required_labels: ["symphony-ready"],
  },
};
const githubLabels = {
  ready: "symphony-ready",
  blocked: "symphony-blocked",
  in_progress: "symphony-in-progress",
};
const githubEnv = { GITHUB_TOKEN: "synthetic-value" };
function githubFixture(overrides: Record<string, unknown> = {}) {
  const calls: URL[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.method, undefined, "Only GET requests may run");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer synthetic-value",
    );
    const payloads: Record<string, unknown> = {
      "/repos/example/demo-app": {
        full_name: "Example/Demo-App",
        has_issues: true,
      },
      "/repos/example/demo-app/labels": Object.values(githubLabels).map(
        (name) => ({ name: name.toUpperCase() }),
      ),
      "/repos/example/demo-app/issues": [
        { labels: [{ name: "Symphony-Ready" }] },
        { labels: [{ name: "symphony-idea" }] },
        { labels: [{ name: "symphony-ready" }], pull_request: {} },
      ],
      ...overrides,
    };
    assert.ok(Object.hasOwn(payloads, url.pathname), url.pathname);
    return Response.json(payloads[url.pathname]);
  };
  return { calls, fetchImpl };
}

test("GitHub preflight checks the repository, labels and the runtime's poll without writes", async () => {
  const mock = githubFixture();
  assert.deepEqual(
    await checkGitHub(githubConfig, githubLabels, {
      env: githubEnv,
      fetchImpl: mock.fetchImpl,
    }),
    { repo: "example/demo-app", labels: 3, polled: 2, eligible: 1 },
  );
  const poll = mock.calls.find((url) => url.pathname.endsWith("/issues"));
  assert.equal(poll?.searchParams.get("state"), "open");
  assert.equal(poll?.searchParams.get("per_page"), "100");
});

test("GitHub preflight rejects missing labels, disabled issues and a missing token", async () => {
  await assert.rejects(
    checkGitHub(githubConfig, githubLabels, {
      env: githubEnv,
      fetchImpl: githubFixture({
        "/repos/example/demo-app/labels": [{ name: "symphony-ready" }],
      }).fetchImpl,
    }),
    /Missing GitHub labels: symphony-blocked, symphony-in-progress/,
  );
  await assert.rejects(
    checkGitHub(githubConfig, githubLabels, {
      env: githubEnv,
      fetchImpl: githubFixture({
        "/repos/example/demo-app": {
          full_name: "example/demo-app",
          has_issues: false,
        },
      }).fetchImpl,
    }),
    /Issues are disabled/,
  );
  await assert.rejects(
    checkGitHub(githubConfig, githubLabels, {
      env: {},
      fetchImpl: githubFixture().fetchImpl,
    }),
    /Missing GITHUB_TOKEN/,
  );
});

test("GitHub preflight follows label pages and never exposes response bodies or the token", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` }));
  const calls: URL[] = [];
  const paged = async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/labels"))
      return Response.json(
        url.searchParams.get("page") === "1"
          ? many
          : Object.values(githubLabels).map((name) => ({ name })),
      );
    if (url.pathname.endsWith("/issues")) return Response.json([]);
    return Response.json({ full_name: "example/demo-app", has_issues: true });
  };
  assert.equal(
    (
      await checkGitHub(githubConfig, githubLabels, {
        env: githubEnv,
        fetchImpl: paged,
      })
    ).labels,
    3,
  );
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/labels")).length,
    2,
  );
  await assert.rejects(
    checkGitHub(githubConfig, githubLabels, {
      env: githubEnv,
      fetchImpl: async () =>
        new Response("synthetic-value leaked", { status: 401 }),
    }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /synthetic-value/);
      return true;
    },
  );
});
