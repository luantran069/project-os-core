import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const templateRoot = join(coreRoot, "template");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return files.flat();
}

async function isEmptyOrMissing(directory) {
  try {
    return (await readdir(directory)).length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export async function createProject(target, values) {
  for (const key of ["name", "repo", "trackerKey", "owner"])
    if (!values[key]) throw new Error(`Missing required option: ${key}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must look like owner/name");
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(values.trackerKey))
    throw new Error("--tracker-key must be 1-10 uppercase letters or digits");
  const destination = resolve(target);
  if (!(await isEmptyOrMissing(destination)))
    throw new Error(`Target directory is not empty: ${destination}`);

  const version = (await readFile(join(coreRoot, "VERSION"), "utf8")).trim();
  const replacements = {
    __CORE_VERSION__: version,
    __PROJECT_NAME__: values.name,
    __REPO__: values.repo,
    __TRACKER_KEY__: values.trackerKey,
    __OWNER__: values.owner,
    __DATE__: values.date ?? new Date().toISOString().slice(0, 10),
  };

  const written = [];
  for (const source of await listFiles(templateRoot)) {
    const path = relative(templateRoot, source);
    let text = await readFile(source, "utf8");
    for (const [placeholder, value] of Object.entries(replacements))
      text = text.replaceAll(placeholder, value);
    await mkdir(join(destination, path, ".."), { recursive: true });
    await writeFile(join(destination, path), text);
    written.push(path);
  }
  return { destination, version, files: written.sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      repo: { type: "string" },
      "tracker-key": { type: "string" },
      owner: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    console.error(
      'Usage: node scripts/new-project.mjs <target-dir> --name "My App" --repo owner/my-app --tracker-key MA --owner "Name"',
    );
    process.exit(2);
  }
  try {
    const result = await createProject(positionals[0], {
      ...values,
      trackerKey: values["tracker-key"],
    });
    console.log(
      `Created ${result.destination} from Project OS core ${result.version} (${result.files.length} files).`,
    );
    console.log(
      "Next: write memory/vision.md, then fill the TODO(owner) items.",
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
