import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  closedIssues,
  createGitHub,
  imageExtension,
  planAction,
  stageOf,
} from "../board/github.mjs";
import { createBoard, signSession, validSession } from "../board/server.mjs";
import { fakeGitHub, labels } from "./board-fake.mjs";

const password = "correct horse battery";

async function withBoard(run) {
  const fake = fakeGitHub();
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password,
    secure: false,
    github: createGitHub({
      repo: "example/demo-app",
      token: "synthetic-value",
      fetchImpl: fake.fetchImpl,
    }),
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (path, { body, headers = {}, raw = false } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { "Content-Type": "application/json", "X-Board": "1" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return raw
      ? response
      : { status: response.status, body: await response.json() };
  };
  try {
    await run({ call, fake, base });
  } finally {
    server.close();
  }
}

test("stages come from issue state and labels", () => {
  const issue = (state, ...names) => ({
    state,
    labels: names.map((name) => ({ name })),
  });
  assert.equal(stageOf(issue("open"), labels), "idea");
  assert.equal(stageOf(issue("open", "SYMPHONY-PLAN"), labels), "plan");
  assert.equal(stageOf(issue("open", labels.ready), labels), "ready");
  assert.equal(
    stageOf(issue("open", labels.ready, labels.in_progress), labels),
    "running",
  );
  assert.equal(stageOf(issue("open", labels.human_review), labels), "review");
  assert.equal(
    stageOf(issue("open", labels.ready, labels.blocked), labels),
    "blocked",
  );
  assert.equal(stageOf(issue("closed", labels.ready), labels), "done");
});

test("pull requests link to the issues they close", () => {
  assert.deepEqual(
    closedIssues("Closes #4, fixes #7 and resolved #9; see #10"),
    [4, 7, 9],
  );
  assert.deepEqual(closedIssues(null), []);
});

test("each column allows only its own decisions", () => {
  assert.deepEqual(planAction("plan", "approve", labels).add, [labels.ready]);
  assert.equal(planAction("review", "approve", labels).merge, true);
  assert.deepEqual(planAction("review", "revise", labels).add, [labels.ready]);
  assert.equal(planAction("done", "approve", labels), null);
  assert.equal(planAction("running", "approve", labels), null);
});

test("sessions are signed and expire", () => {
  const secret = Buffer.from("fixture-secret");
  const value = signSession(secret, 1_000);
  assert.ok(validSession(secret, value, 2_000));
  assert.ok(!validSession(secret, value, 1_000 + 31 * 86_400_000));
  assert.ok(!validSession(Buffer.from("other"), value, 2_000));
  assert.ok(!validSession(secret, value.replace(/.$/, "x"), 2_000));
  assert.ok(!validSession(secret, undefined));
});

test("the board needs a login and rejects cross-site writes", () =>
  withBoard(async ({ call, base }) => {
    assert.equal((await call("/api/board")).status, 401);
    assert.equal(
      (await call("/api/login", { body: { password: "wrong" } })).status,
      401,
    );
    const page = await fetch(`${base}/`);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.match(await page.text(), /Board dự án/);
    const login = await call("/api/login", { body: { password }, raw: true });
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const forged = await call("/api/features", {
      body: { title: "x" },
      headers: { "X-Board": "" },
    });
    assert.equal(forged.status, 403);
  }));

test("login is locked for five minutes after five wrong passwords", async () => {
  let clock = 0;
  const handle = createBoard({
    project: "Demo",
    repo: "example/demo-app",
    labels,
    password,
    secure: false,
    github: null,
    now: () => clock,
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const login = (value) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    }).then((r) => r.status);
  try {
    for (let i = 0; i < 5; i++) assert.equal(await login("wrong"), 401);
    assert.equal(await login(password), 429);
    clock += 5 * 60_000 + 1;
    assert.equal(await login(password), 200);
  } finally {
    server.close();
  }
});

test("the board shows each feature in its column with PR, CI and preview", () =>
  withBoard(async ({ call }) => {
    await call("/api/login", { body: { password } });
    const { status, body } = await call("/api/board");
    assert.equal(status, 200);
    const by = Object.fromEntries(body.features.map((f) => [f.number, f]));
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => by[n].stage),
      ["idea", "plan", "running", "review", "blocked", "done"],
    );
    assert.equal(by[2].priority, "now");
    assert.deepEqual(
      { ...by[4].pull, title: undefined },
      {
        number: 40,
        title: undefined,
        url: "https://github.com/example/demo-app/pull/40",
        state: "open",
        draft: false,
        sha: "abc",
        checks: "success",
        preview: "https://pr-40.preview.example",
      },
    );
    assert.equal(by[3].pull.checks, "failure");
    const comments = await call("/api/features/3/comments");
    assert.equal(comments.body[0].workpad, true);
  }));

test("approving a plan makes it ready and leaves an audit comment", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    const result = await call("/api/features/2/actions", {
      body: { action: "approve" },
    });
    assert.equal(result.status, 200);
    const issue = fake.issues.find((i) => i.number === 2);
    assert.deepEqual(
      issue.labels.map((l) => l.name).sort(),
      ["priority-now", labels.ready].sort(),
    );
    assert.ok(
      fake.writes.some(
        (w) => w.path === "/issues/2/comments" && /Duyệt G2/.test(w.body.body),
      ),
    );
    const again = await call("/api/features/2/actions", {
      body: { action: "approve" },
    });
    assert.equal(again.status, 409);
  }));

test("approving a review merges the pull request at its head and closes the feature", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    const result = await call("/api/features/4/actions", {
      body: { action: "approve" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.merged, { number: 40, sha: "merged" });
    const merge = fake.writes.find((w) => w.method === "PUT");
    assert.deepEqual(merge, {
      method: "PUT",
      path: "/pulls/40/merge",
      body: { merge_method: "squash", sha: "abc" },
    });
    const issue = fake.issues.find((i) => i.number === 4);
    assert.equal(issue.state, "closed");
    assert.equal(issue.state_reason, "completed");
  }));

test("asking for changes needs a note and sends the feature back to the agent", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    const empty = await call("/api/features/4/actions", {
      body: { action: "revise" },
    });
    assert.equal(empty.status, 400);
    const result = await call("/api/features/4/actions", {
      body: { action: "revise", note: "Thêm test cho trang trống" },
    });
    assert.equal(result.status, 200);
    const issue = fake.issues.find((i) => i.number === 4);
    assert.deepEqual(
      issue.labels.map((l) => l.name),
      [labels.ready],
    );
    assert.ok(
      fake.writes.some((w) =>
        /Thêm test cho trang trống/.test(w.body?.body ?? ""),
      ),
    );
  }));

test("stopping a running agent removes ready and in-progress", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    await call("/api/features/3/actions", { body: { action: "stop" } });
    const issue = fake.issues.find((i) => i.number === 3);
    assert.deepEqual(issue.labels, []);
    assert.equal(issue.state, "open");
  }));

test("a new idea becomes an issue with the idea label", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    assert.equal(
      (await call("/api/features", { body: { title: " " } })).status,
      400,
    );
    const created = await call("/api/features", {
      body: { title: "Cảnh báo giá", body: "Gửi khi giá vượt ngưỡng" },
    });
    assert.equal(created.status, 201);
    const issue = fake.issues.at(-1);
    assert.deepEqual(
      issue.labels.map((l) => l.name),
      [labels.idea],
    );
  }));

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==",
  "base64",
);

test("image types come from the file's bytes", () => {
  assert.equal(imageExtension(pixel), "png");
  assert.equal(imageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(imageExtension(Buffer.from("GIF89a")), "gif");
  assert.equal(imageExtension(Buffer.from("RIFF0000WEBPVP8 ")), "webp");
  assert.equal(imageExtension(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(imageExtension(Buffer.alloc(0)), null);
});

test("an image goes to its own branch and comes back through the board", () =>
  withBoard(async ({ call, fake }) => {
    const data = pixel.toString("base64");
    assert.equal((await call("/api/images", { body: { data } })).status, 401);
    await call("/api/login", { body: { password } });
    const first = await call("/api/images", {
      body: { name: "lỗi [map](x).png", data },
    });
    assert.equal(first.status, 201);
    assert.match(first.body.id, /^\d{4}-\d{2}\/[a-f0-9]{32}\.png$/);
    assert.equal(
      first.body.markdown,
      `![lỗi mapx.png](https://github.com/example/demo-app/blob/board-images/images/${first.body.id}?raw=true)`,
    );
    assert.ok(fake.writes.some((w) => w.path === "/git/refs"));

    const second = await call("/api/images", { body: { data } });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.id, first.body.id);
    assert.equal(fake.imageFiles.size, 2);
    assert.equal(fake.writes.filter((w) => w.path === "/git/refs").length, 1);

    const image = await call(`/api/images/${first.body.id}`, { raw: true });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("cache-control"), /^private/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), pixel);
  }));

test("the board refuses other files and oversized images", () =>
  withBoard(async ({ call, fake }) => {
    await call("/api/login", { body: { password } });
    const svg = Buffer.from("<svg onload=alert(1)>").toString("base64");
    assert.equal(
      (await call("/api/images", { body: { data: svg } })).status,
      400,
    );
    assert.equal(
      (await call("/api/images", { body: { data: "" } })).status,
      400,
    );
    const large = Buffer.concat([pixel, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal(
      (await call("/api/images", { body: { data: large.toString("base64") } }))
        .status,
      413,
    );
    assert.equal(fake.imageFiles.size, 0);
  }));

test("only image ids can be read, and only after login", () =>
  withBoard(async ({ call }) => {
    const id = `2026-11/${"a".repeat(32)}.png`;
    assert.equal((await call(`/api/images/${id}`, { raw: true })).status, 401);
    await call("/api/login", { body: { password } });
    for (const path of [
      "/api/images/..%2F..%2Fproject.yaml",
      "/api/images/2026-11/secret.yaml",
      `/api/images/2026-11/${"a".repeat(32)}.svg`,
    ])
      assert.equal((await call(path, { raw: true })).status, 404);
    const missing = await call(`/api/images/${id}`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(JSON.stringify(missing.body), /secret detail/);
  }));

test("GitHub errors never pass the response body or token through", () =>
  withBoard(async ({ call }) => {
    await call("/api/login", { body: { password } });
    const result = await call("/api/features/99/actions", {
      body: { action: "approve" },
    });
    assert.equal(result.status, 404);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /synthetic-value|unexpected/,
    );
  }));
