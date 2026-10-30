import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProject } from "../scripts/new-project.mjs";
import {
  adfToMarkdown,
  issueFor,
  migrate,
  stageLabels,
} from "../symphony/migrate-jira.mjs";

const labels = {
  idea: "symphony-idea",
  plan: "symphony-plan",
  ready: "symphony-ready",
  in_progress: "symphony-in-progress",
  blocked: "symphony-blocked",
  human_review: "symphony-human-review",
  pilot_review: "symphony-pilot-review",
};
const text = (value, marks) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const para = (...content) => ({ type: "paragraph", content });

test("Jira descriptions become Markdown", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Kết quả")] },
      para(
        text("Xem "),
        text("báo cáo", [
          { type: "link", attrs: { href: "https://example.com" } },
        ]),
        text(" và "),
        text("npm test", [{ type: "code" }]),
      ),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("một"))] },
          { type: "listItem", content: [para(text("hai"))] },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { state: "DONE" },
            content: [text("xong")],
          },
          {
            type: "taskItem",
            attrs: { state: "TODO" },
            content: [text("chưa")],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "sh" },
        content: [text("echo hi")],
      },
    ],
  };
  assert.equal(
    adfToMarkdown(doc),
    "## Kết quả\n\nXem [báo cáo](https://example.com) và `npm test`\n\n- một\n- hai\n\n- [x] xong\n- [ ] chưa\n\n```sh\necho hi\n```",
  );
  assert.equal(adfToMarkdown(null), "");
});

test("Jira status and labels map to board stages", () => {
  assert.deepEqual(stageLabels("Parking lot", ["symphony-idea"], labels), [
    labels.idea,
  ]);
  assert.deepEqual(stageLabels("Discovery", [], labels), [labels.plan]);
  assert.deepEqual(
    stageLabels("Ready for delivery", ["symphony-ready"], labels),
    [labels.ready],
  );
  assert.deepEqual(stageLabels("Delivery", ["symphony-ready"], labels), [
    labels.ready,
    labels.in_progress,
  ]);
  assert.deepEqual(
    stageLabels("Impact", ["symphony-ready", "symphony-pilot-review"], labels),
    [labels.human_review, labels.pilot_review],
  );
  assert.deepEqual(stageLabels("Delivery", ["symphony-blocked"], labels), [
    labels.blocked,
  ]);
});

test("a ticket keeps its topic labels, roadmap priority and blockers", () => {
  const issue = issueFor(
    {
      key: "IS-12",
      fields: {
        summary: "Daily data route",
        status: { name: "Discovery" },
        labels: ["symphony-plan", "banking"],
        customfield_1: { value: "Now" },
        issuelinks: [
          { type: { name: "Blocks" }, inwardIssue: { key: "IS-7" } },
          { type: { name: "Blocks" }, outwardIssue: { key: "IS-16" } },
        ],
        description: { type: "doc", content: [para(text("Scope"))] },
      },
    },
    { labels, jiraBase: "https://jira.example", roadmapField: "customfield_1" },
  );
  assert.deepEqual(issue.labels, [labels.plan, "priority-now", "banking"]);
  assert.deepEqual(issue.blockedBy, ["IS-7"]);
  assert.match(issue.body, /^<!-- jira:IS-12 -->\n/);
  assert.match(issue.body, /\nScope$/);
});

function fakes() {
  const writes = [];
  const issues = [{ number: 1, body: "<!-- jira:IS-11 -->\nalready moved" }];
  const ticket = (key, status, category, extra = {}) => ({
    key,
    fields: {
      summary: `Title ${key}`,
      status: { name: status, statusCategory: { key: category } },
      labels: [],
      issuelinks: [],
      comment: { comments: [] },
      ...extra,
    },
  });
  const tickets = [
    ticket("IS-8", "Done", "done"),
    ticket("IS-11", "Impact", "indeterminate"),
    ticket("IS-12", "Discovery", "new", {
      issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "IS-11" } }],
      comment: {
        comments: [
          {
            author: { displayName: "Agent" },
            created: "2026-10-01",
            body: { type: "doc", content: [para(text("## Agent Workpad"))] },
          },
        ],
      },
    }),
  ];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.hostname === "jira.example") {
      assert.ok(
        url.pathname === "/rest/api/3/field" ||
          url.pathname === "/rest/api/3/search/jql",
      );
      if (url.pathname === "/rest/api/3/field")
        return Response.json([{ id: "customfield_9", name: "Roadmap" }]);
      assert.match(body.jql, /^project = "IS"/);
      return Response.json({ isLast: true, issues: tickets });
    }
    const path = url.pathname.replace("/repos/example/demo-app", "");
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/issues" && method === "GET") return Response.json(issues);
    if (path === "/labels" && method === "GET")
      return Response.json([{ name: "symphony-plan" }]);
    if (path === "/issues" && method === "POST")
      return Response.json({ number: 2 }, { status: 201 });
    return Response.json({}, { status: method === "POST" ? 201 : 200 });
  };
  return { fetchImpl, writes };
}

const env = {
  JIRA_BASE_URL: "https://jira.example",
  JIRA_EMAIL: "fixture@example.com",
  JIRA_API_TOKEN: "synthetic",
  GITHUB_TOKEN: "synthetic",
};

async function withProject(run) {
  const dir = await mkdtemp(join(tmpdir(), "migrate-"));
  try {
    await createProject(join(dir, "p"), {
      name: "Demo",
      repo: "example/demo-app",
      owner: "X",
    });
    await run(join(dir, "p"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a dry run writes nothing and lists what would move", () =>
  withProject(async (root) => {
    const { fetchImpl, writes } = fakes();
    const lines = [];
    const result = await migrate({
      root,
      jiraProject: "IS",
      repo: "example/demo-app",
      env,
      fetchImpl,
      log: (l) => lines.push(l),
    });
    assert.deepEqual(writes, []);
    assert.equal(result.archived, 1);
    assert.ok(lines.some((l) => l.startsWith("skip   IS-11")));
    assert.ok(
      lines.some(
        (l) => l.startsWith("create IS-12") && l.includes("blocked by IS-11"),
      ),
    );
  }));

test("apply creates missing issues, labels, comments, dependencies and the archive", () =>
  withProject(async (root) => {
    const { fetchImpl, writes } = fakes();
    const result = await migrate({
      root,
      jiraProject: "IS",
      repo: "example/demo-app",
      apply: true,
      env,
      fetchImpl,
      log: () => {},
      date: "2026-10-30",
    });
    assert.deepEqual(result.created, [{ key: "IS-12", number: 2 }]);
    const created = writes.find(
      (w) => w.path === "/issues" && w.method === "POST",
    );
    assert.deepEqual(created.body.labels, ["symphony-plan"]);
    assert.ok(
      writes.some(
        (w) => w.path === "/labels" && w.body.name === "symphony-in-progress",
      ),
    );
    assert.ok(
      !writes.some(
        (w) => w.path === "/labels" && w.body.name === "symphony-plan",
      ),
    );
    assert.ok(
      writes.some(
        (w) =>
          w.path === "/issues/2/comments" && /Agent Workpad/.test(w.body.body),
      ),
    );
    const patch = writes.find((w) => w.method === "PATCH");
    assert.equal(patch.path, "/issues/2");
    assert.match(patch.body.body, /cần xong #1 trước/);
    const archive = await readFile(join(root, "docs/jira-archive.md"), "utf8");
    assert.match(archive, /\[IS-8\]\(https:\/\/jira.example\/browse\/IS-8\)/);
  }));

test("missing credentials stop before any request", () =>
  withProject(async (root) => {
    await assert.rejects(
      migrate({
        root,
        jiraProject: "IS",
        repo: "example/demo-app",
        env: { ...env, GITHUB_TOKEN: "" },
        fetchImpl: () => assert.fail("no request"),
      }),
      /Missing GITHUB_TOKEN/,
    );
  }));
