import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectRoot } from "./project.mjs";
const root = pathToFileURL(`${projectRoot()}/`);
const manifest = JSON.parse(
  await readFile(new URL("runtime.json", import.meta.url), "utf8"),
);
const target = `${{ linux: "linux", darwin: "macos" }[process.platform]}_${{ x64: "x86_64", arm64: "arm64" }[process.arch]}`;
const expected = manifest.sha256[target];
if (!expected)
  throw new Error(
    `Unsupported Symphony platform: ${process.platform}/${process.arch}`,
  );
const directory = new URL(".symphony/bin/", root);
const destination = new URL("symphony", directory);
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
let existing;
try {
  existing = await readFile(destination);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing && hash(existing) === expected) {
  console.log(
    `Symphony ${manifest.version} already installed and checksum verified.`,
  );
} else {
  const name = `symphony-${manifest.version}-${target}`;
  const url = `https://github.com/${manifest.repository}/releases/download/${manifest.version}/${name}`;
  console.log(`Downloading ${name}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new Error(`Download failed with HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (hash(buffer) !== expected)
    throw new Error("Symphony checksum mismatch; installation rejected");
  await mkdir(directory, { recursive: true });
  const temporary = new URL("symphony.download", directory);
  await writeFile(temporary, buffer, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  await writeFile(
    new URL("installed.json", directory),
    JSON.stringify(
      {
        version: manifest.version,
        target,
        sha256: expected,
        installedAt: new Date().toISOString(),
        url,
      },
      null,
      2,
    ),
  );
  console.log(`Installed and checksum verified: ${fileURLToPath(destination)}`);
}
