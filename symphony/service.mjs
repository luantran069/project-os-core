import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { readProject, slug, vendorPath } from "./project.mjs";

// One user service per project, named after project.yaml project.name.
export const serviceNameFor = (projectName) =>
  `${slug(projectName)}-symphony.service`;
const jiraKeys = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"];
const githubKeys = ["GITHUB_TOKEN"];
const execute = promisify(execFile);
const clean = (value) => {
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Configuration values must not contain control characters");
  return value;
};
const unitQuote = (value, command = false) =>
  `"${clean(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (command ? "$$" : "$"))}"`;
// These path directives do not parse quoted words or C escapes in systemd 239.
// Keep literal spaces/backslashes, escape specifiers, and reject line-continuation
// or trimming ambiguity instead of changing the path.
const unitPath = (value) => {
  clean(value);
  if (/\s$/.test(value) || value.endsWith("\\"))
    throw new Error(
      "Service directive paths cannot end with whitespace or a backslash",
    );
  return value.replaceAll("%", "%%");
};

const envFile = (keys, values) =>
  keys
    .map(
      (key) =>
        `${key}="${values[key].replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join("\n") + "\n";

// EnvironmentFile has no shell expansion. Only these keys cross the service boundary.
function pickEnvironment(source, keys) {
  // parseEnv discards carriage returns; reject bare ones instead of altering a token.
  if (source.replaceAll("\r\n", "\n").includes("\r"))
    throw new Error("Credential source contains a bare carriage return");
  const input = parseEnv(source);
  const values = Object.fromEntries(keys.map((key) => [key, input[key]]));
  for (const key of keys) {
    if (!values[key]?.trim())
      throw new Error(`Missing ${key} in credential source`);
    clean(values[key]);
  }
  return values;
}

export function jiraEnvironment(source) {
  const values = pickEnvironment(source, jiraKeys);
  const base = new URL(values.JIRA_BASE_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "JIRA_BASE_URL must be an HTTPS URL without embedded credentials",
    );
  if (!/^[^\s@]+@[^\s@]+$/.test(values.JIRA_EMAIL))
    throw new Error("JIRA_EMAIL must be the token owner's email address");
  return envFile(jiraKeys, values);
}

export function githubEnvironment(source) {
  const values = pickEnvironment(source, githubKeys);
  if (/\s/.test(values.GITHUB_TOKEN))
    throw new Error("GITHUB_TOKEN must not contain whitespace");
  return envFile(githubKeys, values);
}

export const trackerEnvironment = (kind, source) =>
  kind === "github" ? githubEnvironment(source) : jiraEnvironment(source);

export const trackerLabel = (kind) => (kind === "github" ? "GitHub" : "Jira");

export function serviceUnit({
  projectName,
  tracker = "jira",
  runtime,
  node,
  codex,
  environment,
  sshIdentity,
}) {
  if (!projectName?.trim() || !slug(projectName))
    throw new Error("serviceUnit needs the project name from project.yaml");
  clean(projectName);
  for (const path of [runtime, node, codex, environment, sshIdentity].filter(
    Boolean,
  )) {
    clean(path);
    if (!isAbsolute(path)) throw new Error("Service paths must be absolute");
  }
  const path = [
    ...new Set([
      dirname(node),
      dirname(codex),
      join(homedir(), ".local/bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ].join(":");
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const ssh = sshIdentity
    ? `Environment=${unitQuote(`GIT_SSH_COMMAND=/usr/bin/ssh -i ${shellQuote(sshIdentity)} -o IdentitiesOnly=yes -o BatchMode=yes`)}\n`
    : "";
  return `[Unit]
Description=${projectName} Symphony ${trackerLabel(tracker)} worker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${unitPath(runtime)}
EnvironmentFile=${unitPath(environment)}
Environment=${unitQuote(`PATH=${path}`)}
UnsetEnvironment=NODE_OPTIONS NODE_PATH
${ssh}ExecStart=${unitQuote(node, true)} ${unitQuote(join(runtime, vendorPath, "start.mjs"), true)}
Restart=on-failure
RestartSec=15
TimeoutStopSec=45
KillMode=control-group
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${slug(projectName)}-symphony

[Install]
WantedBy=default.target
`;
}

async function run(command, args, allowFailure = false) {
  const code = await new Promise((res, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status) => res(status ?? 1));
  });
  if (code && !allowFailure)
    throw new Error(`${command} failed (exit ${code})`);
  return code;
}

async function privateWrite(path, content) {
  const temporary = `${path}.new-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function serviceLogCommand(runtime, follow = false) {
  clean(runtime);
  if (!isAbsolute(runtime))
    throw new Error("The configured service WorkingDirectory must be absolute");
  const directory = join(runtime, ".symphony/logs/log");
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    throw new Error(
      "No readable runtime log directory; start the service and check its configured WorkingDirectory",
    );
  }
  const segments = [];
  for (const name of entries.filter((name) =>
    /^symphony\.log\.[1-5]$/.test(name),
  )) {
    const path = join(directory, name);
    try {
      const entry = await lstat(path);
      if (!entry.isFile()) continue;
      await access(path, constants.R_OK);
      segments.push({ path, modified: entry.mtimeMs });
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  segments.sort(
    (a, b) => b.modified - a.modified || b.path.localeCompare(a.path),
  );
  if (!segments.length)
    throw new Error(
      "No readable numbered Symphony logs; start the service before inspecting runtime logs",
    );
  return {
    command: "tail",
    args: follow
      ? [
          "--lines=100",
          "--follow=name",
          "--retry",
          "--quiet",
          "--",
          ...Array.from({ length: 5 }, (_, index) =>
            join(directory, `symphony.log.${index + 1}`),
          ),
        ]
      : ["--lines=100", "--", segments[0].path],
  };
}

async function logs(flags, serviceName) {
  if (flags.some((flag) => !["--follow", "--journal"].includes(flag)))
    throw new Error("logs accepts only --follow and --journal");
  const follow = flags.includes("--follow");
  if (flags.includes("--journal")) {
    await run("journalctl", [
      "--user",
      "--unit",
      serviceName,
      "--lines",
      "100",
      "--no-pager",
      ...(follow ? ["--follow"] : []),
    ]);
    return;
  }
  let configured;
  try {
    const result = await execute("systemctl", [
      "--user",
      "show",
      serviceName,
      "--property=WorkingDirectory",
      "--value",
    ]);
    configured = result.stdout.trim();
  } catch {
    throw new Error(
      "Cannot read the service WorkingDirectory; check symphony:service -- status",
    );
  }
  const selected = await serviceLogCommand(configured, follow);
  await run(selected.command, selected.args);
}

async function main() {
  if (process.platform !== "linux")
    throw new Error("This installer needs Linux systemd");
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "logs") {
    const { project } = await readProject();
    await logs(args, serviceNameFor(project.name));
    return;
  }
  const options = {};
  const allowed = ["runtime", "env-source", "node", "codex", "ssh-identity"];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (
      !allowed.includes(key) ||
      !args[i].startsWith("--") ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(`Expected --${allowed.join(", --")} followed by a path`);
    options[key] = resolve(args[i + 1]);
  }
  if (command === "install") {
    const runtime = options.runtime;
    const source = options["env-source"];
    if (!runtime || !source)
      throw new Error(
        "install requires --runtime <stable-checkout> --env-source <private-env>",
      );
    const node = options.node ?? process.execPath;
    const codex = options.codex ?? join(homedir(), ".local/bin/codex");
    const sshIdentity = options["ssh-identity"];
    for (const path of [node, codex, join(runtime, ".symphony/bin/symphony")])
      await access(path, constants.X_OK);
    const manifest = await readProject(runtime);
    const { project } = manifest;
    const tracker = manifest.tracker?.kind ?? "jira";
    const serviceName = serviceNameFor(project.name);
    for (const path of [
      join(runtime, "WORKFLOW.md"),
      join(runtime, vendorPath, "start.mjs"),
      ...(sshIdentity ? [sshIdentity] : []),
    ])
      await access(path, constants.R_OK);
    const credentials = trackerEnvironment(
      tracker,
      await readFile(source, "utf8"),
    );
    const config = join(homedir(), ".config", slug(project.name));
    const environment = join(config, "symphony.env");
    const units = join(homedir(), ".config/systemd/user");
    const unit = serviceUnit({
      projectName: project.name,
      tracker,
      runtime,
      node,
      codex,
      environment,
      sshIdentity,
    });
    await mkdir(config, { recursive: true, mode: 0o700 });
    await chmod(config, 0o700);
    await mkdir(units, { recursive: true });
    await privateWrite(environment, credentials);
    await privateWrite(join(units, serviceName), unit);
    await run("systemctl", ["--user", "daemon-reload"]);
    console.log(
      `Installed ${serviceName}; no start, restart, or enable was requested.`,
    );
    const label = trackerLabel(tracker);
    console.log(`Private ${label} credentials: ${environment} (mode 0600).`);
    console.log(
      `Review the eligible ${label} queue before explicitly running symphony:service -- start.`,
    );
    return;
  }
  if (args.length) throw new Error("Path options apply only to install");
  const { project } = await readProject();
  const serviceName = serviceNameFor(project.name);
  const operations = {
    start: ["enable", "--now", serviceName],
    stop: ["stop", serviceName],
    restart: ["restart", serviceName],
    disable: ["disable", "--now", serviceName],
    status: ["status", "--no-pager", serviceName],
  };
  if (operations[command]) {
    process.exitCode = await run(
      "systemctl",
      ["--user", ...operations[command]],
      command === "status",
    );
  } else {
    throw new Error(
      "Use install, start, stop, restart, disable, status, or logs",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Parse errors can contain source text. Keep credential-file content out of output.
    const message =
      error instanceof SyntaxError
        ? "Invalid credential-file syntax"
        : error.message;
    console.error(`Symphony service: ${message}`);
    process.exitCode = 1;
  });
}
