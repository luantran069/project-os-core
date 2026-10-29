import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));

export const requiredFiles = [
  "project.yaml",
  "AGENTS.md",
  "WORKFLOW.md",
  "memory/vision.md",
  "memory/state.md",
  "memory/learnings.md",
  "docs/idea-planning-template.md",
];

// Reads `key: value` from a top-level section of a simple YAML file. Only the
// flat layout used by template/project.yaml is supported.
export function readYamlValue(text, section, key) {
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) inside = line.trim() === `${section}:`;
    else if (inside) {
      const match = line.match(/^\s+([\w-]+):\s*(.*)$/);
      if (match?.[1] === key) return match[2].trim() || undefined;
    }
  }
  return undefined;
}

const semver = /^(\d+)\.(\d+)\.(\d+)$/;
const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.match(semver).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

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

  const manifest = await readFile(join(root, "project.yaml"), "utf8");
  const version = readYamlValue(manifest, "core", "version");
  const coreVersion = (
    await readFile(join(coreRoot, "VERSION"), "utf8")
  ).trim();
  if (!version || !semver.test(version))
    errors.push("project.yaml core.version must be a version like 0.1.0");
  else if (compare(version, coreVersion) > 0)
    errors.push(
      `project.yaml uses core ${version}, newer than this core (${coreVersion})`,
    );
  else if (compare(version, coreVersion) < 0)
    warnings.push(`Core ${coreVersion} is available; project uses ${version}`);

  const ready = readYamlValue(manifest, "labels", "ready");
  if (!ready) errors.push("project.yaml labels.ready is missing");
  else {
    const workflow = await readFile(join(root, "WORKFLOW.md"), "utf8");
    const front = workflow.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const required = front.match(
      /required_labels:\s*\r?\n((?:\s+-\s*.+\r?\n?)+)/,
    );
    const labels =
      required?.[1].match(/-\s*(\S+)/g)?.map((l) => l.replace(/^-\s*/, "")) ??
      [];
    if (!labels.includes(ready))
      errors.push(
        `WORKFLOW.md required_labels must include the ready label "${ready}"`,
      );
  }

  let todos = 0;
  for (const file of await textFiles(root)) {
    const text = await readFile(file, "utf8");
    const leftover = text.match(/__[A-Z_]+__/);
    if (leftover)
      errors.push(
        `${file.slice(root.length + 1)} still contains placeholder ${leftover[0]}`,
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
