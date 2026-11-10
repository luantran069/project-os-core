import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyAction,
  createGitHub,
  planAction,
  stageOf,
} from "../board/github.mjs";
import { createController } from "../orchestrator/controller.mjs";
import { decide } from "../orchestrator/policy.mjs";
import {
  createReviewer,
  globToRegExp,
  ownerFiles,
  parseVerdict,
  reviewSettings,
  settle,
} from "../orchestrator/review.mjs";
import { configure } from "../orchestrator/start.mjs";
import { createStore } from "../orchestrator/store.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const label = (name) => ({ name });

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "review-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const verdictText = (verdict) =>
  `Reviewed.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`;

test("review settings default to the owner and check the ai block", () => {
  assert.deepEqual(reviewSettings({}), {
    enabled: false,
    maxRounds: 2,
    ownerPaths: [],
  });
  const ai = reviewSettings({
    labels,
    gates: { merge: "ai" },
    review: { max_rounds: 1, owner_paths: [" .github/** "] },
  });
  assert.deepEqual(ai, {
    enabled: true,
    maxRounds: 1,
    ownerPaths: [".github/**"],
  });
  assert.throws(
    () => reviewSettings({ gates: { merge: "yes" } }),
    /gates.merge/,
  );
  assert.throws(
    () => reviewSettings({ gates: { merge: "ai" }, labels: { ready: "r" } }),
    /labels.ai_review/,
  );
  assert.throws(
    () => reviewSettings({ review: { max_rounds: 9 } }),
    /max_rounds/,
  );
  assert.throws(
    () => reviewSettings({ review: { owner_paths: "x" } }),
    /owner_paths/,
  );
});

test("owner paths match like gitignore globs", () => {
  const globs = [
    ".github/**",
    "project.yaml",
    "**/migrations/**",
    "**/package.json",
    "*.gradle*",
    ".env*",
  ];
  assert.deepEqual(
    ownerFiles(
      [
        ".github/workflows/ci.yml",
        "project.yaml",
        "docs/project.yaml",
        "backend/internal/migrations/0002_users.sql",
        "web/package.json",
        "package.json",
        "android/app/build.gradle.kts",
        ".env.example",
        "web/src/App.tsx",
        "design/happyclink/Today.dc.html",
      ],
      globs,
    ),
    [
      ".github/workflows/ci.yml",
      "project.yaml",
      "docs/project.yaml",
      "backend/internal/migrations/0002_users.sql",
      "web/package.json",
      "package.json",
      "android/app/build.gradle.kts",
      ".env.example",
    ],
  );
  assert.ok(globToRegExp("/project.yaml").test("project.yaml"));
  assert.ok(!globToRegExp("/project.yaml").test("docs/project.yaml"));
  assert.ok(globToRegExp("docs/").test("docs/a.md"));
  assert.ok(globToRegExp("node_modules/").test("web/node_modules/x.js"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("docs/").test("docs/a/b.md"));
});

test("the verdict is the last valid json block", () => {
  const text =
    '```json\n{"verdict":"revise","head":"abc"}\n```\n' +
    "```\nnot json\n```\n" +
    verdictText({
      verdict: "approve",
      head: "abcdef1",
      summary: " Ổn. ",
      findings: ["", "a"],
    });
  assert.deepEqual(parseVerdict(text), {
    verdict: "approve",
    head: "abcdef1",
    summary: "Ổn.",
    findings: ["a"],
  });
  assert.equal(parseVerdict("no block"), null);
  assert.equal(parseVerdict('```json\n{"verdict":"merge it"}\n```'), null);
});

test("the rules decide, not the verdict", () => {
  const sha = "abcdef1234567";
  const pull = { head: { sha }, draft: false, mergeable: true };
  const ok = { state: "success" };
  const approve = { verdict: "approve", head: sha, summary: "", findings: [] };
  const base = {
    verdict: approve,
    reviewedSha: sha,
    pull,
    checks: ok,
    owned: [],
    rounds: 0,
    maxRounds: 2,
  };
  const action = (patch) => settle({ ...base, ...patch }).action;
  assert.equal(action({}), "merge");
  assert.equal(action({ pull: null }), "escalate");
  assert.equal(action({ pull: { ...pull, head: { sha: "fff" } } }), "again");
  assert.equal(action({ owned: [".github/x"] }), "escalate");
  assert.equal(action({ verdict: null }), "escalate");
  assert.equal(
    action({ verdict: { ...approve, head: "0000000" } }),
    "escalate",
  );
  assert.equal(action({ verdict: { ...approve, head: "abcdef1" } }), "merge");
  assert.equal(
    action({ verdict: { ...approve, verdict: "escalate" } }),
    "escalate",
  );
  assert.equal(
    action({ verdict: { ...approve, verdict: "revise" } }),
    "revise",
  );
  assert.equal(
    action({ verdict: { ...approve, verdict: "revise" }, rounds: 2 }),
    "escalate",
  );
  assert.equal(action({ checks: { state: "failure" } }), "revise");
  assert.equal(action({ checks: { state: "failure" }, rounds: 2 }), "escalate");
  for (const state of ["pending", "none", "unknown"])
    assert.equal(action({ checks: { state } }), "escalate");
  assert.equal(action({ pull: { ...pull, draft: true } }), "escalate");
  assert.equal(action({ pull: { ...pull, mergeable: false } }), "escalate");
  assert.equal(action({ pull: { ...pull, mergeable: null } }), "merge");
});

test("the reviewer may read and run checks but never change anything", () => {
  const as = (toolName, input) =>
    decide(toolName, input, { workspace: "/ws", role: "reviewer" }).behavior;
  const bash = (command) => as("Bash", { command });
  for (const command of [
    "gh pr diff 40",
    "gh pr view 40 --comments",
    "gh pr checkout 40 --detach",
    "npm test",
    "gh api repos/a/b/pulls/40/files",
  ])
    assert.equal(bash(command), "allow", command);
  for (const command of [
    "gh pr merge 40 --squash",
    "git push origin HEAD",
    "gh pr review 40 --approve",
    "gh pr comment 40 -b hi",
    "gh issue edit 4 --add-label x",
    "gh label create x",
    "gh api repos/a/b/issues/4/labels -X POST",
    "gh api repos/a/b/issues/4/comments -f body=x",
  ])
    assert.equal(bash(command), "deny", command);
  assert.equal(as("Write", { file_path: "/ws/a.txt" }), "deny");
  assert.equal(as("AskUserQuestion", { questions: [] }), "deny");
  // The coder's policy is unchanged.
  assert.equal(
    decide("Bash", { command: "gh pr merge 1" }, { workspace: "/ws" }).behavior,
    "ask",
  );
});

test("ai_review is a review stage and every review decision clears it", async () => {
  assert.equal(
    stageOf({ state: "open", labels: [label(labels.ai_review)] }, labels),
    "review",
  );
  for (const action of ["approve", "revise", "stop"])
    assert.ok(
      planAction("review", action, labels).remove.includes(labels.ai_review),
    );
  // A merge refuses a head that moved after the review.
  const fake = fakeGitHub();
  const gh = createGitHub({
    repo: "example/demo-app",
    token: "x",
    fetchImpl: fake.fetchImpl,
  });
  await assert.rejects(
    applyAction(gh, labels, 4, "approve", "", "AI", { expectSha: "zzz" }),
    /commit mới/,
  );
  assert.equal(fake.pulls[0].state, "open");
});

test("configure reads gates.merge", () => {
  const env = {
    BOARD_URL: "http://board:8080",
    AGENT_TOKEN: "t".repeat(40),
    GITHUB_TOKEN: "g",
  };
  const manifest = {
    runtime: { orchestrator: "claude" },
    tracker: { kind: "github", repo: "example/demo-app" },
    labels,
  };
  assert.equal(configure(manifest, env).review.enabled, false);
  assert.equal(
    configure({ ...manifest, gates: { merge: "ai" } }, env).review.enabled,
    true,
  );
  assert.throws(
    () => configure({ ...manifest, gates: { merge: "auto" } }, env),
    /gates.merge/,
  );
});

// The fake's #4 waits for review with PR #40 (head abc, green CI).
function reviewHarness(dir, { settings = {}, issueLabels } = {}) {
  const fake = fakeGitHub();
  const issue = fake.issues.find((i) => i.number === 4);
  issue.labels = (issueLabels ?? [labels.ai_review]).map(label);
  fake.pulls[0].head.sha = "abc1234def";
  const gh = createGitHub({
    repo: "example/demo-app",
    token: "x",
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      // CI for any head: green unless the test says otherwise.
      if (/\/commits\/\w+\/check-runs$/.test(url.pathname))
        return Response.json({
          check_runs:
            fake.ci === "none"
              ? []
              : [
                  {
                    name: "ci",
                    status: "completed",
                    conclusion: fake.ci ?? "success",
                  },
                ],
        });
      // Branch protection refusing the merge.
      if (fake.refuseMerge && /\/pulls\/\d+\/merge$/.test(url.pathname))
        return Response.json({}, { status: 405 });
      return fake.fetchImpl(input, init);
    },
  });
  const sent = [];
  const runner = {
    send: (issue, text, opts) => sent.push({ issue, text, opts }),
    busy: () => false,
  };
  const store = createStore(dir);
  const reviewer = createReviewer({
    gh,
    labels,
    settings: { enabled: true, maxRounds: 2, ownerPaths: [], ...settings },
    runner,
    store,
    workspaces: { prepare: async (n) => `/reviews/${n}` },
    repo: "example/demo-app",
    agent: "luan-mac",
    log: () => {},
  });
  return { fake, issue, sent, store, reviewer };
}

const comments = (fake) => (fake.comments[4] ?? []).map((c) => c.body);
const names = (issue) => issue.labels.map((l) => l.name).sort();

test("an approved PR with green CI is merged at the reviewed head", () =>
  withDir(async (dir) => {
    const { fake, issue, sent, store, reviewer } = reviewHarness(dir);
    await reviewer.tick(fake.issues);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /pull request #40/);
    assert.match(sent[0].text, /abc1234def/);
    assert.equal(sent[0].opts.workspace, "/reviews/4");
    assert.equal(store.get(4).reviewedSha, "abc1234def");
    // Nothing more while the review runs.
    await reviewer.tick(fake.issues);
    assert.equal(sent.length, 1);
    const result = await reviewer.onResult(4, {
      ok: true,
      text: verdictText({
        verdict: "approve",
        head: "abc1234def",
        summary: "Đạt mọi tiêu chí.",
        findings: [],
      }),
    });
    assert.equal(result, "merged");
    const merge = fake.writes.find((w) => w.path === "/pulls/40/merge");
    assert.deepEqual(merge.body, { merge_method: "squash", sha: "abc1234def" });
    assert.equal(issue.state, "closed");
    assert.deepEqual(names(issue), []);
    assert.match(
      comments(fake).at(-1),
      /^\*\*Duyệt PR: merge\*\* \(AI reviewer của `luan-mac`\)/,
    );
    assert.match(comments(fake).at(-1), /Đạt mọi tiêu chí/);
  }));

test("revise sends the feature back twice, then the owner decides", () =>
  withDir(async (dir) => {
    const { fake, issue, sent, reviewer } = reviewHarness(dir);
    const revise = (head) =>
      verdictText({
        verdict: "revise",
        head,
        summary: "Thiếu test.",
        findings: ["Thêm test cho trường hợp lỗi"],
      });
    // Each round the coder pushes a fix and hands off again.
    const heads = ["abc1234def", "bbb2222aaa", "ccc3333bbb"];
    for (const [round, head] of heads.entries()) {
      fake.pulls[0].head.sha = head;
      issue.labels = [label(labels.ai_review)];
      await reviewer.tick(fake.issues);
      assert.equal(sent.length, round + 1);
      assert.match(sent[round].text, new RegExp(head));
      const result = await reviewer.onResult(4, {
        ok: true,
        text: revise(head),
      });
      if (round < 2) {
        assert.equal(result, "revised");
        assert.deepEqual(names(issue), [labels.ready]);
        assert.match(
          comments(fake).at(-1),
          /^\*\*Yêu cầu sửa PR\*\* \(AI reviewer/,
        );
        assert.match(comments(fake).at(-1), /Thêm test cho trường hợp lỗi/);
      } else {
        assert.equal(result, "escalated");
        assert.deepEqual(names(issue), [labels.human_review]);
        assert.match(comments(fake).at(-1), /tối đa 2/);
      }
    }
    assert.equal(
      fake.writes.some((w) => w.path === "/pulls/40/merge"),
      false,
    );
  }));

test("owner paths, failing or missing CI decide without a review session", () =>
  withDir(async (dir) => {
    const owned = reviewHarness(join(dir, "a"), {
      settings: { ownerPaths: ["web/**"] },
    });
    await owned.reviewer.tick(owned.fake.issues);
    assert.equal(owned.sent.length, 0);
    assert.deepEqual(names(owned.issue), [labels.human_review]);
    assert.match(comments(owned.fake).at(-1), /web\/src\/Detail.tsx/);

    const red = reviewHarness(join(dir, "b"));
    red.fake.ci = "failure";
    await red.reviewer.tick(red.fake.issues);
    assert.equal(red.sent.length, 0);
    assert.deepEqual(names(red.issue), [labels.ready]);
    assert.match(comments(red.fake).at(-1), /CI thất bại/);

    const none = reviewHarness(join(dir, "c"));
    none.fake.ci = "none";
    await none.reviewer.tick(none.fake.issues);
    assert.equal(none.sent.length, 0);
    assert.deepEqual(names(none.issue), [labels.human_review]);
    assert.match(comments(none.fake).at(-1), /none/);
  }));

test("the owner's review label keeps the reviewer away", () =>
  withDir(async (dir) => {
    const { fake, sent, issue, reviewer } = reviewHarness(dir, {
      issueLabels: [labels.ai_review, labels.human_review],
    });
    await reviewer.tick(fake.issues);
    assert.equal(sent.length, 0);
    // The owner claims it while a review runs: the verdict is dropped.
    issue.labels = [label(labels.ai_review)];
    await reviewer.tick(fake.issues);
    assert.equal(sent.length, 1);
    issue.labels.push(label(labels.human_review));
    const result = await reviewer.onResult(4, {
      ok: true,
      text: verdictText({ verdict: "approve", head: "abc1234def" }),
    });
    assert.equal(result, "skipped");
    assert.equal(
      fake.writes.some((w) => w.path === "/pulls/40/merge"),
      false,
    );
  }));

test("a push during the review starts a new review of the new head", () =>
  withDir(async (dir) => {
    const { fake, sent, store, reviewer } = reviewHarness(dir);
    await reviewer.tick(fake.issues);
    fake.pulls[0].head.sha = "fff9999";
    const result = await reviewer.onResult(4, {
      ok: true,
      text: verdictText({ verdict: "approve", head: "abc1234def" }),
    });
    assert.equal(result, "again");
    assert.equal(store.get(4).settledSha, null);
    assert.equal(
      fake.writes.some((w) => w.path === "/pulls/40/merge"),
      false,
    );
    await reviewer.tick(fake.issues);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /fff9999/);
  }));

test("the controller hands its own open features to the reviewer", () =>
  withDir(async (dir) => {
    const fake = fakeGitHub();
    fake.issues.find((i) => i.number === 4).labels.push(label("agent:other"));
    const gh = createGitHub({
      repo: "example/demo-app",
      token: "x",
      fetchImpl: fake.fetchImpl,
    });
    const seen = [];
    const controller = createController({
      gh,
      labels,
      store: createStore(dir),
      runner: { send: () => {}, busy: () => true },
      workspaces: { prepare: async (n) => `/ws/${n}` },
      workflowPrompt: "Do {{ issue.identifier }}",
      reviewer: {
        tick: async (issues) => seen.push(issues.map((i) => i.number)),
      },
    });
    await controller.tick();
    assert.deepEqual(seen, [[1, 2, 3, 5]]);
  }));

test("a merge GitHub refuses goes to the owner", () =>
  withDir(async (dir) => {
    const { fake, issue, reviewer } = reviewHarness(dir);
    fake.refuseMerge = true;
    await reviewer.tick(fake.issues);
    const result = await reviewer.onResult(4, {
      ok: true,
      text: verdictText({ verdict: "approve", head: "abc1234def" }),
    });
    assert.equal(result, "escalated");
    assert.equal(issue.state, "open");
    assert.deepEqual(names(issue), [labels.human_review]);
    assert.match(comments(fake).at(-1), /GitHub không cho merge.*HTTP 405/);
  }));

test("a review stopped by shutdown is not settled", async () => {
  const { createRunner } = await import("../orchestrator/runner.mjs");
  await withDir(async (dir) => {
    const results = [];
    const runner = createRunner({
      query: ({ options }) =>
        (async function* () {
          await new Promise((resolve) =>
            options.abortController.signal.addEventListener("abort", resolve),
          );
          throw new Error("aborted");
        })(),
      store: createStore(dir),
      emit: () => {},
      role: "reviewer",
      onResult: (issue, result) => results.push(result),
    });
    runner.send(4, "review", { workspace: dir });
    await new Promise((resolve) => setTimeout(resolve, 10));
    runner.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(results, []);
  });
});
