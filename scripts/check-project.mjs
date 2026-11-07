import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkWorkflow } from "../symphony/check.mjs";
import { placeholders } from "./new-project.mjs";
import {
  coreVersion,
  manifestPath,
  moduleFiles,
  sha256,
  vendorPath,
} from "./sync-project.mjs";

export const requiredFiles = [
  "project.yaml",
  "AGENTS.md",
  "WORKFLOW.md",
  "memory/vision.md",
  "memory/state.md",
  "memory/learnings.md",
  "docs/idea-planning-template.md",
];

const semver = /^(\d+)\.(\d+)\.(\d+)$/;
const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.match(semver).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// A template placeholder, or one Prettier rewrote to bold. Other bold capitals
// such as **IMPORTANT** are ordinary text.
const leftoverPlaceholder = new RegExp(
  `__[A-Z_]+__|\\*\\*(?:${placeholders.join("|")})\\*\\*`,
);

async function textFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(
        (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return textFiles(path);
        return /\.(md|ya?ml)$/.test(entry.name) ? [path] : [];
      }),
  );
  return nested.flat();
}

// Compares the project's copy of the Symphony module with its core.json pin,
// and with this core when the versions match.
async function checkVendored(root, version, current, errors, warnings) {
  let pin;
  try {
    pin = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  } catch {
    errors.push(
      `Missing ${manifestPath}; run project-os-core/scripts/sync-project.mjs`,
    );
    return;
  }
  if (pin.version !== version)
    errors.push(
      `${manifestPath} is for core ${pin.version}, but project.yaml pins ${version}`,
    );
  for (const [path, hash] of Object.entries(pin.files ?? {})) {
    let text;
    try {
      text = await readFile(join(root, path), "utf8");
    } catch {
      errors.push(`Missing ${path}`);
      continue;
    }
    if (sha256(text) !== hash)
      errors.push(`${path} was edited locally; change it in the core instead`);
  }
  if (version !== current) return;
  const expected = await moduleFiles();
  for (const [name, text] of Object.entries(expected)) {
    const path = `${vendorPath}/${name}`;
    if (pin.files?.[path] !== sha256(text))
      errors.push(`${path} does not match core ${current}; sync the project`);
  }
  for (const path of Object.keys(pin.files ?? {}))
    if (!(path.slice(vendorPath.length + 1) in expected))
      warnings.push(`${path} is no longer part of core ${current}`);
}

export async function checkProject(directory) {
  const root = resolve(directory);
  const errors = [];
  const warnings = [];

  for (const file of requiredFiles) {
    try {
      await access(join(root, file));
    } catch {
      errors.push(`Missing ${file}`);
    }
  }
  if (errors.length) return { errors, warnings };

  let manifest;
  try {
    manifest = parse(await readFile(join(root, "project.yaml"), "utf8"));
  } catch (error) {
    errors.push(`project.yaml is not valid YAML: ${error.message}`);
    return { errors, warnings };
  }
  const version = String(manifest?.core?.version ?? "");
  const current = await coreVersion();
  if (!semver.test(version))
    errors.push("project.yaml core.version must be a version like 0.1.0");
  else if (compare(version, current) > 0)
    errors.push(
      `project.yaml uses core ${version}, newer than this core (${current})`,
    );
  else if (compare(version, current) < 0)
    warnings.push(`Core ${current} is available; project uses ${version}`);

  if (!manifest?.labels?.ready)
    errors.push("project.yaml labels.ready is missing");

  const orchestrator = manifest?.runtime?.orchestrator;
  if (orchestrator === "symphony" || orchestrator === "claude")
    if (semver.test(version))
      await checkVendored(root, version, current, errors, warnings);
  if (orchestrator === "claude") {
    const host = manifest.runtime.host ?? "mac";
    if (!["mac", "dokploy"].includes(host))
      errors.push("project.yaml runtime.host must be mac or dokploy");
    if (manifest?.tracker?.kind !== "github")
      errors.push("The Claude orchestrator needs tracker.kind: github");
  }
  if (orchestrator === "symphony") {
    try {
      await checkWorkflow(false, root);
    } catch (error) {
      errors.push(`WORKFLOW.md: ${error.message}`);
    }
  }

  let todos = 0;
  for (const file of await textFiles(root)) {
    const text = await readFile(file, "utf8");
    const leftover = text.match(leftoverPlaceholder);
    if (leftover)
      errors.push(
        `${relative(root, file).replaceAll("\\", "/")} still contains placeholder ${leftover[0]}`,
      );
    todos += text.match(/TODO\(owner\)/g)?.length ?? 0;
  }
  if (todos) warnings.push(`${todos} TODO(owner) item(s) still to fill in`);

  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/check-project.mjs <project-dir>");
    process.exit(2);
  }
  const { errors, warnings } = await checkProject(target);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    errors.length ? "Project check failed." : "Project check passed.",
  );
  process.exit(errors.length ? 1 : 0);
}
