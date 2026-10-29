import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProject, readYamlValue } from "../scripts/check-project.mjs";
import { createProject } from "../scripts/new-project.mjs";

const options = {
  name: "Demo App",
  repo: "example/demo-app",
  trackerKey: "DA",
  owner: "Example Owner",
  date: "2026-10-29",
};

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

test("a new project fills every placeholder and passes the check", () =>
  withProject(async (target) => {
    const manifest = await readFile(join(target, "project.yaml"), "utf8");
    const version = (
      await readFile(new URL("../VERSION", import.meta.url), "utf8")
    ).trim();
    assert.equal(readYamlValue(manifest, "core", "version"), version);
    assert.equal(readYamlValue(manifest, "tracker", "project_key"), "DA");
    const workflow = await readFile(join(target, "WORKFLOW.md"), "utf8");
    assert.match(workflow, /git@github.com:example\/demo-app.git/);
    assert.match(workflow, /\{\{ issue.identifier \}\}/);
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
    createProject("unused", { ...options, trackerKey: "da" }),
    /uppercase/,
  );
});

test("the check reports a missing file, a newer core and a label mismatch", () =>
  withProject(async (target) => {
    const manifestPath = join(target, "project.yaml");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifest
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
