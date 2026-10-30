import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflow } from "./check.mjs";
import { projectRoot } from "./project.mjs";

export async function main() {
  const root = projectRoot();
  try {
    await checkWorkflow(true, root);
  } catch (error) {
    console.error(`Symphony cannot start: ${error.message}`);
    process.exit(1);
  }
  const logs = join(root, ".symphony/logs");
  await mkdir(logs, { recursive: true });
  const child = spawn(
    join(root, ".symphony/bin/symphony"),
    [
      "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
      join(root, "WORKFLOW.md"),
      "--logs-root",
      logs,
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
