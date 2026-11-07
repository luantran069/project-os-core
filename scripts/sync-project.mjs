import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
// Core modules a project receives a copy of, under .project-os/<module>/.
export const modules = ["symphony", "board", "orchestrator"];
export const vendorPath = ".project-os";
export const manifestPath = ".project-os/core.json";

// Keeps vendored files LF in a project, whatever the project's other files use.
export const eolRule = `${vendorPath}/** text eol=lf`;

const toLf = (text) => text.replaceAll("\r\n", "\n");

// Git may check a text file out with CRLF and commit it with LF, so a hash covers
// the text and not its line endings.
export const sha256 = (text) =>
  createHash("sha256").update(toLf(text)).digest("hex");

export async function coreVersion() {
  return (await readFile(join(coreRoot, "VERSION"), "utf8")).trim();
}

// The files a project receives, keyed "<module>/<file>": every module file
// except tests or notes.
export async function moduleFiles() {
  const files = {};
  for (const module of modules) {
    const names = (await readdir(join(coreRoot, module))).filter((name) =>
      /\.(mjs|json|html)$|^Dockerfile$/.test(name),
    );
    for (const name of names.sort())
      files[`${module}/${name}`] = toLf(
        await readFile(join(coreRoot, module, name), "utf8"),
      );
  }
  return files;
}

const readme = (version) => `# Project OS files

Copied from [project-os-core](https://github.com/luantran069/project-os-core)
${version} by \`scripts/sync-project.mjs\`: \`symphony/\` runs the agents,
\`board/\` is the owner's feature board,
\`orchestrator/\` runs one Claude session per feature (runtime.orchestrator: claude). Do not edit these files here: change
them in the core, release a new core version, then sync this project again.
\`check-project\` fails when a file differs from \`core.json\`.
`;

// Adds eolRule to the project's .gitattributes unless it is already there.
async function pinLineEndings(root) {
  const file = join(root, ".gitattributes");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pinned = text
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/).join(" ") === eolRule);
  if (pinned) return;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" || text.endsWith("\n") ? "" : eol;
  await writeFile(file, `${text}${separator}${eolRule}${eol}`);
}

// Copies the core's modules (Symphony, the board and the orchestrator) into a project and pins project.yaml to
// this core version. Re-running it on the same version changes nothing.
export async function syncProject(target) {
  const root = resolve(target);
  const manifestFile = join(root, "project.yaml");
  const manifest = await readFile(manifestFile, "utf8");
  const version = await coreVersion();
  const files = await moduleFiles();

  for (const module of modules) {
    await rm(join(root, vendorPath, module), { recursive: true, force: true });
    await mkdir(join(root, vendorPath, module), { recursive: true });
  }
  for (const [name, text] of Object.entries(files))
    await writeFile(join(root, vendorPath, name), text);
  await writeFile(join(root, ".project-os/README.md"), readme(version));
  await pinLineEndings(root);
  await writeFile(
    join(root, manifestPath),
    `${JSON.stringify(
      {
        repository: "luantran069/project-os-core",
        version,
        files: Object.fromEntries(
          Object.entries(files).map(([name, text]) => [
            `${vendorPath}/${name}`,
            sha256(text),
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );

  const pinned = manifest.replace(
    /^(core:\s*\n(?:[ \t]+.*\r?\n)*?[ \t]+version:[ \t]*)\S+/m,
    `$1${version}`,
  );
  if (pinned === manifest && !manifest.match(/^core:[\s\S]*?version:/m))
    throw new Error("project.yaml needs a core.version entry");
  if (pinned !== manifest) await writeFile(manifestFile, pinned);

  const warnings = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps.yaml)
      warnings.push(
        'package.json needs the "yaml" package for the Symphony scripts',
      );
    if (
      /^\s*orchestrator:\s*claude\b/m.test(manifest) &&
      !deps["@anthropic-ai/claude-agent-sdk"]
    )
      warnings.push(
        'package.json needs "@anthropic-ai/claude-agent-sdk" for the Claude orchestrator',
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    warnings.push("No package.json; the Symphony scripts need Node and yaml");
  }
  return { version, files: Object.keys(files), warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/sync-project.mjs <project-dir>");
    process.exit(2);
  }
  try {
    const result = await syncProject(target);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
    console.log(
      `Synced Project OS core ${result.version} (${result.files.length} module files) into ${resolve(target)}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
