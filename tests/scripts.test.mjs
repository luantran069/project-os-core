import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { checkWorkflow } from "../symphony/check.mjs";
import { checkProject } from "../scripts/check-project.mjs";
import { createProject } from "../scripts/new-project.mjs";
import { syncProject, vendorPath } from "../scripts/sync-project.mjs";

const symphonyPath = `${vendorPath}/symphony`;

const options = {
  name: "Demo Ứng Dụng",
  repo: "example/demo-app",
  owner: "Example Owner",
  date: "2026-10-29",
};
const version = (
  await readFile(new URL("../VERSION", import.meta.url), "utf8")
).trim();

async function withProject(run) {
  const root = await mkdtemp(join(tmpdir(), "project-os-"));
  try {
    const target = join(root, "demo");
    await createProject(target, options);
    await run(target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const edit = async (path, change) =>
  writeFile(path, change(await readFile(path, "utf8")));

test("a new project fills every placeholder, vendors Symphony and passes the check", () =>
  withProject(async (target) => {
    const manifest = parse(
      await readFile(join(target, "project.yaml"), "utf8"),
    );
    assert.equal(manifest.core.version, version);
    assert.deepEqual(manifest.tracker, {
      kind: "github",
      repo: "example/demo-app",
    });
    const pkg = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    );
    assert.equal(pkg.name, "demo-ung-dung");
    const workflow = await readFile(join(target, "WORKFLOW.md"), "utf8");
    assert.match(workflow, /git@github.com:example\/demo-app.git/);
    assert.match(workflow, /\{\{ issue.identifier \}\}/);
    assert.match(workflow, /repo: example\/demo-app/);
    const pin = JSON.parse(
      await readFile(join(target, ".project-os/core.json"), "utf8"),
    );
    assert.equal(pin.version, version);
    assert.ok(`${symphonyPath}/codex.mjs` in pin.files);
    for (const file of ["server.mjs", "github.mjs", "index.html", "Dockerfile"])
      assert.ok(`${vendorPath}/board/${file}` in pin.files, file);
    assert.equal(
      await readFile(join(target, symphonyPath, "check.mjs"), "utf8"),
      await readFile(new URL("../symphony/check.mjs", import.meta.url), "utf8"),
    );
    await checkWorkflow(false, target);
    const { errors, warnings } = await checkProject(target);
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => w.includes("TODO(owner)")));
  }));

test("creating into a non-empty directory is refused", () =>
  withProject(async (target) => {
    await assert.rejects(createProject(target, options), /not empty/);
  }));

test("invalid options are refused", async () => {
  await assert.rejects(
    createProject("unused", { ...options, repo: "bad" }),
    /owner\/name/,
  );
  await assert.rejects(
    createProject("unused", { ...options, owner: "" }),
    /Missing required option: owner/,
  );
});

test("the check reports a missing file, a newer core and a label mismatch", () =>
  withProject(async (target) => {
    await edit(join(target, "project.yaml"), (text) =>
      text
        .replace(/version: .*/, "version: 99.0.0")
        .replace("ready: symphony-ready", "ready: os-ready"),
    );
    await rm(join(target, "memory/learnings.md"));
    assert.deepEqual((await checkProject(target)).errors, [
      "Missing memory/learnings.md",
    ]);

    await writeFile(join(target, "memory/learnings.md"), "# Learnings\n");
    const { errors } = await checkProject(target);
    assert.ok(errors.some((e) => e.includes("newer than this core")));
    assert.ok(errors.some((e) => e.includes('ready label "os-ready"')));
  }));

test("leftover placeholders are errors", () =>
  withProject(async (target) => {
    await writeFile(join(target, "memory/state.md"), "Owner: __OWNER__\n");
    const { errors } = await checkProject(target);
    assert.ok(
      errors.some(
        (e) => e.includes("memory/state.md") && e.includes("__OWNER__"),
      ),
    );
  }));

test("a locally edited Symphony file fails the check until the project is synced again", () =>
  withProject(async (target) => {
    await edit(
      join(target, symphonyPath, "codex.mjs"),
      (text) => `${text}\n// local`,
    );
    const { errors } = await checkProject(target);
    assert.ok(errors.some((e) => e.includes("codex.mjs was edited locally")));

    await syncProject(target);
    assert.deepEqual((await checkProject(target)).errors, []);
  }));

test("sync pins project.yaml to this core version", () =>
  withProject(async (target) => {
    const path = join(target, "project.yaml");
    await edit(path, (text) => text.replace(/version: .*/, "version: 0.0.1"));
    await syncProject(target);
    assert.equal(parse(await readFile(path, "utf8")).core.version, version);
  }));

test("the workflow check reads the project's tracker repo, limits and commands", () =>
  withProject(async (target) => {
    const workflow = join(target, "WORKFLOW.md");
    const original = await readFile(workflow, "utf8");
    for (const [change, message] of [
      [
        (t) => t.replace("repo: example/demo-app", "repo: example/other"),
        /tracker repo/,
      ],
      [(t) => t.replace("kind: github", "kind: jira"), /tracker\.kind/],
      [(t) => t.replace("    - open\n", "    - Delivery\n"), /open/],
      [
        (t) => t.replace("token: $GITHUB_TOKEN", "token: literal-value"),
        /environment reference/,
      ],
      [
        (t) => t.replaceAll("symphony-in-progress", "running"),
        /symphony-in-progress/,
      ],
      [(t) => t.replace("max_turns: 8", "max_turns: 20"), /max_turns/],
      [
        (t) =>
          t.replace("node .project-os/symphony/codex.mjs", "codex app-server"),
        /node \.project-os\/symphony\/codex\.mjs/,
      ],
      [(t) => t.replace(/^    npm ci\n/m, ""), /after_create must run npm ci/],
      [(t) => t.replaceAll("match-head-commit", "head"), /match-head-commit/],
    ]) {
      await writeFile(workflow, change(original));
      await assert.rejects(checkWorkflow(false, target), message);
    }
    await writeFile(workflow, original);
    await edit(join(target, "project.yaml"), (text) =>
      text.replace("verify_command: null", "verify_command: npm run verify"),
    );
    await assert.rejects(checkWorkflow(false, target), /npm run verify/);
  }));

test("projects still on Jira keep passing the Jira contract", () =>
  withProject(async (target) => {
    const fixture = await readFile(
      new URL("./fixtures/jira-WORKFLOW.md", import.meta.url),
      "utf8",
    );
    const workflow = join(target, "WORKFLOW.md");
    await writeFile(
      workflow,
      fixture
        .replaceAll("__TRACKER_KEY__", "DA")
        .replaceAll("__REPO__", "example/demo-app"),
    );
    const manifest = join(target, "project.yaml");
    await edit(manifest, (text) =>
      text.replace(
        /tracker:\n  kind: github\n  repo: .*\n/,
        "tracker:\n  kind: jira\n  project_key: DA\n",
      ),
    );
    await checkWorkflow(false, target);
    await edit(workflow, (text) => text.replaceAll("Impact", "Review"));
    await assert.rejects(checkWorkflow(false, target), /Impact/);
  }));
