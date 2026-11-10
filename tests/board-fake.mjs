import assert from "node:assert/strict";

// In-memory stand-in for the parts of the GitHub REST API the board uses.
export const labels = {
  idea: "symphony-idea",
  plan: "symphony-plan",
  ready: "symphony-ready",
  in_progress: "symphony-in-progress",
  blocked: "symphony-blocked",
  human_review: "symphony-human-review",
  pilot_review: "symphony-pilot-review",
};

export function fakeGitHub() {
  const label = (name) => ({ name });
  const at = "2026-10-30T10:00:00Z";
  const issues = [
    {
      number: 1,
      title: "Lọc quỹ theo ngành",
      state: "open",
      labels: [label(labels.idea), label("priority-next")],
    },
    {
      number: 2,
      title: "So sánh hai báo cáo quỹ",
      state: "open",
      labels: [label(labels.plan), label("priority-now")],
      body: "## Kế hoạch\n- [ ] Bảng so sánh\n- [ ] Xuất CSV",
    },
    {
      number: 3,
      title: "Thêm biểu đồ dòng tiền",
      state: "open",
      labels: [label(labels.ready), label(labels.in_progress)],
    },
    {
      number: 4,
      title: "Trang chi tiết cổ phiếu",
      state: "open",
      labels: [label(labels.human_review)],
    },
    {
      number: 5,
      title: "Đăng nhập Google",
      state: "open",
      labels: [label(labels.blocked)],
    },
    { number: 6, title: "Chuyển ngôn ngữ", state: "closed", labels: [] },
  ].map((issue) => ({
    body: "",
    comments: 0,
    updated_at: at,
    html_url: `https://github.com/example/demo-app/issues/${issue.number}`,
    ...issue,
  }));
  const pulls = [
    {
      number: 40,
      title: "Trang chi tiết",
      state: "open",
      body: "Closes #4\n\nPreview: https://pr-40.preview.example",
      head: { sha: "abc" },
      html_url: "https://github.com/example/demo-app/pull/40",
    },
    {
      number: 41,
      title: "Biểu đồ",
      state: "open",
      body: "Fixes #3",
      head: { sha: "def" },
      html_url: "https://github.com/example/demo-app/pull/41",
    },
  ];
  const comments = {
    3: [
      {
        user: { login: "agent" },
        created_at: at,
        body: "## Agent Workpad\n- [x] Plan\n- [ ] Tests",
      },
    ],
  };
  const writes = [];
  const diffs = {
    40:
      "diff --git a/web/src/Detail.tsx b/web/src/Detail.tsx\n" +
      "+x\n".repeat(30_000),
  };
  const imageFiles = new Map();
  const sessionFiles = new Map();
  let imageBranch = false;
  let trees = {};
  const json = (body, status = 200) => Response.json(body, { status });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = decodeURI(url.pathname).replace("/repos/example/demo-app", "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ method, path, body });
    let m;
    if (method === "GET" && path === "/issues") {
      const state = url.searchParams.get("state");
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(page > 1 ? [] : issues.filter((i) => i.state === state));
    }
    if (method === "GET" && path === "/pulls") {
      const state = url.searchParams.get("state");
      return json(pulls.filter((p) => state === "all" || p.state === state));
    }
    if (method === "GET" && (m = path.match(/^\/pulls\/(\d+)$/))) {
      const pull = pulls.find((p) => p.number === Number(m[1]));
      if (!pull) return json({}, 404);
      if (init.headers.Accept === "application/vnd.github.diff")
        return new Response(diffs[pull.number] ?? "");
      return json({
        user: { login: "agent-bot" },
        base: { ref: "master" },
        head: { ...pull.head, ref: `ai/pr-${pull.number}` },
        mergeable: true,
        ...pull,
      });
    }
    if (method === "GET" && (m = path.match(/^\/pulls\/(\d+)\/files$/)))
      return json(
        Number(url.searchParams.get("page") ?? 1) > 1
          ? []
          : [
              {
                filename: "web/src/Detail.tsx",
                status: "added",
                additions: 3,
                deletions: 0,
              },
            ],
      );
    if (method === "POST" && (m = path.match(/^\/pulls\/(\d+)\/reviews$/)))
      return json(
        { html_url: `https://github.com/example/demo-app/pull/${m[1]}#review` },
        200,
      );
    if (method === "GET" && (m = path.match(/^\/commits\/(\w+)\/check-runs$/)))
      return json({
        check_runs: [
          {
            status: "completed",
            conclusion: m[1] === "abc" ? "success" : "failure",
          },
        ],
      });
    if (method === "GET" && path === "/deployments") return json([]);
    if ((m = path.match(/^\/issues\/(\d+)$/))) {
      const issue = issues.find((i) => i.number === Number(m[1]));
      if (!issue) return json({}, 404);
      if (method === "PATCH") Object.assign(issue, body);
      return json(issue);
    }
    if (method === "GET" && (m = path.match(/^\/issues\/(\d+)\/comments$/)))
      return json(comments[m[1]] ?? []);
    if (method === "POST" && (m = path.match(/^\/issues\/(\d+)\/comments$/)))
      return json({}, 201);
    if (method === "POST" && (m = path.match(/^\/issues\/(\d+)\/labels$/))) {
      const issue = issues.find((i) => i.number === Number(m[1]));
      issue.labels.push(...body.labels.map(label));
      return json(issue.labels);
    }
    if (
      method === "DELETE" &&
      (m = path.match(/^\/issues\/(\d+)\/labels\/(.+)$/))
    ) {
      const issue = issues.find((i) => i.number === Number(m[1]));
      const name = decodeURIComponent(m[2]);
      issue.labels = issue.labels.filter((l) => l.name !== name);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && (m = path.match(/^\/pulls\/(\d+)\/merge$/))) {
      const pull = pulls.find((p) => p.number === Number(m[1]));
      if (body.sha !== pull.head.sha) return json({}, 409);
      pull.state = "closed";
      pull.merged_at = "2026-10-30T11:00:00Z";
      return json({ sha: "merged" });
    }
    if (method === "POST" && path === "/issues") {
      const issue = {
        number: issues.length + 1,
        title: body.title,
        body: body.body,
        state: "open",
        labels: body.labels.map(label),
        comments: 0,
        updated_at: at,
        html_url: "https://github.com/example/demo-app/issues/new",
      };
      issues.push(issue);
      return json(issue, 201);
    }
    if (method === "GET" && path === "/git/ref/heads/board-images")
      return imageBranch ? json({ object: { sha: "tip" } }) : json({}, 404);
    if (method === "POST" && path === "/git/blobs")
      return json({ sha: body.content }, 201);
    if (method === "POST" && path === "/git/trees") {
      trees = body.tree;
      return json({ sha: "tree" }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      assert.deepEqual(body.parents, []);
      return json({ sha: "first" }, 201);
    }
    if (method === "POST" && path === "/git/refs") {
      assert.equal(body.ref, "refs/heads/board-images");
      imageBranch = true;
      for (const entry of trees) imageFiles.set(entry.path, entry.sha);
      return json({}, 201);
    }
    if (method === "PUT" && (m = path.match(/^\/contents\/(.+)$/))) {
      if (body.branch !== "board-images" || !imageBranch) return json({}, 404);
      imageFiles.set(m[1], body.content);
      return json({}, 201);
    }
    if (method === "GET" && (m = path.match(/^\/contents\/sessions\/(.+)$/))) {
      assert.equal(url.searchParams.get("ref"), "board-sessions");
      assert.equal(init.headers.Accept, "application/vnd.github.raw");
      const file = sessionFiles.get(m[1]);
      return file
        ? new Response(file)
        : json({ message: "secret detail" }, 404);
    }
    if (method === "GET" && (m = path.match(/^\/contents\/(.+)$/))) {
      assert.equal(url.searchParams.get("ref"), "board-images");
      assert.equal(init.headers.Accept, "application/vnd.github.raw");
      const file = imageFiles.get(m[1]);
      return file
        ? new Response(Buffer.from(file, "base64"))
        : json({ message: "secret detail" }, 404);
    }
    return json({ message: "unexpected" }, 500);
  };
  return { fetchImpl, issues, pulls, writes, imageFiles, sessionFiles, diffs };
}
