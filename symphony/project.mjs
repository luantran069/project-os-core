import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

// Where a project keeps its copy of this module, relative to the project root.
export const vendorPath = ".project-os/symphony";
export const codexCommand = `node ${vendorPath}/codex.mjs`;
export const archiveCommand = `node ${vendorPath}/archive.mjs`;

// Every command runs from the project root: npm scripts, the systemd unit's
// WorkingDirectory and Symphony's issue workspaces all set it as the cwd.
export const projectRoot = () => process.cwd();

export async function readProject(root = projectRoot()) {
  const manifest = parse(await readFile(join(root, "project.yaml"), "utf8"));
  if (!manifest?.project?.name)
    throw new Error("project.yaml needs project.name");
  return manifest;
}

export const slug = (name) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function readWorkflow(root = projectRoot()) {
  return parseWorkflow(await readFile(join(root, "WORKFLOW.md"), "utf8"));
}

// WORKFLOW.md's YAML frontmatter (config) and the agent prompt after it.
export function parseWorkflow(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match)
    throw new Error("WORKFLOW.md needs YAML frontmatter and a nonempty prompt");
  return { config: parse(match[1]), prompt: match[2] };
}
