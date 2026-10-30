import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleRoot = join(coreRoot, "symphony");
export const vendorPath = ".project-os/symphony";
export const manifestPath = ".project-os/core.json";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export async function coreVersion() {
  return (await readFile(join(coreRoot, "VERSION"), "utf8")).trim();
}

// The files a project receives: every module file except tests or notes.
export async function moduleFiles() {
  const names = (await readdir(moduleRoot)).filter((name) =>
    /\.(mjs|json)$/.test(name),
  );
  const files = {};
  for (const name of names.sort())
    files[name] = await readFile(join(moduleRoot, name), "utf8");
  return files;
}

const readme = (version) => `# Project OS files

Copied from [project-os-core](https://github.com/luantran069/project-os-core)
${version} by \`scripts/sync-project.mjs\`. Do not edit these files here: change
them in the core, release a new core version, then sync this project again.
\`check-project\` fails when a file differs from \`core.json\`.
`;

// Copies the core's Symphony module into a project and pins project.yaml to
// this core version. Re-running it on the same version changes nothing.
export async function syncProject(target) {
  const root = resolve(target);
  const manifestFile = join(root, "project.yaml");
  const manifest = await readFile(manifestFile, "utf8");
  const version = await coreVersion();
  const files = await moduleFiles();

  const destination = join(root, vendorPath);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(destination, name), text);
  await writeFile(join(root, ".project-os/README.md"), readme(version));
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
    /^(core:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:[ \t]*)\S+/m,
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
      `Synced Project OS core ${result.version} (${result.files.length} Symphony files) into ${resolve(target)}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
