// Gives a personal machine its own board token, kept only on that machine. It
// prints the token's sha256: fingerprint, the one line the board (Dokploy)
// needs, and never prints the token itself.
//
//   node .project-os/board/token.mjs agent <name> [--env-file .env] [--force]
//     An orchestrator: writes AGENT_NAME and AGENT_TOKEN into .env.
//   node .project-os/board/token.mjs mcp <name> --board https://<board domain>
//       [--server <name>] [--scope user|local|project]
//     The owner's AI: adds the board to Claude Code with the token.
//   node .project-os/board/token.mjs hash < token.txt
//     The fingerprint of a token you already have, to replace it on the board.
import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readProject, slug } from "../symphony/project.mjs";
import { hashToken, newToken, tokenName } from "./tokens.mjs";

const usage = `Usage:
  node .project-os/board/token.mjs agent <name> [--env-file .env] [--force]
  node .project-os/board/token.mjs mcp <name> --board https://<board domain> [--server <name>] [--scope user|local|project]
  node .project-os/board/token.mjs hash < token.txt`;

const fail = (message) => Object.assign(new Error(message), { usage: true });

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--force") options.force = true;
    else if (arg.startsWith("--")) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--"))
        throw fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else positional.push(arg);
  }
  return { command, name: positional[0], extra: positional.slice(1), options };
}

const checkName = (name) => {
  if (!tokenName.test(name ?? ""))
    throw fail(
      "Give the machine a name: a-z, 0-9 and dashes, up to 31 characters",
    );
  return name;
};

// Sets KEY=value lines in an env file, keeping every other line.
export function setEnv(text, values) {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const left = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const key = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
    )?.[1];
    if (!key || !left.has(key)) return line;
    const value = left.get(key);
    left.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of left) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

const readText = async (file) => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// The board's /mcp address from what the owner typed.
export function mcpUrl(board) {
  let url;
  try {
    url = new URL(String(board ?? ""));
  } catch {
    throw fail("--board must be the board's address, https://<board domain>");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw fail("--board must use https:// (http:// only for localhost)");
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "")}/mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function agent(name, options, { cwd, out }) {
  const file = resolve(cwd, options["env-file"] ?? ".env");
  const text = await readText(file);
  if (/^\s*(?:export\s+)?AGENT_TOKEN\s*=\s*\S/m.test(text) && !options.force)
    throw fail(
      `${file} already has an AGENT_TOKEN. Pass --force to replace it; the board then needs the new fingerprint.`,
    );
  const token = newToken();
  await writeFile(
    file,
    setEnv(text, { AGENT_NAME: name, AGENT_TOKEN: token }),
    {
      mode: 0o600,
    },
  );
  await chmod(file, 0o600);
  out(`Saved AGENT_NAME=${name} and a new AGENT_TOKEN in ${file}.`);
  out(
    "The token stays on this machine. Add this line to the board's AGENT_TOKENS",
  );
  out(
    "(Dokploy, comma-separated with the other agents), then redeploy the board:",
  );
  out("");
  out(`  ${name}=${hashToken(token)}`);
}

async function mcp(name, options, { cwd, env, exec, out }) {
  const url = mcpUrl(options.board);
  const scope = options.scope ?? "user";
  if (!["user", "local", "project"].includes(scope))
    throw fail("--scope is user, local or project");
  if (scope === "project")
    throw fail(
      "--scope project would write the token into .mcp.json in the repository; use user or local",
    );
  let server = options.server;
  if (!server) {
    const project = await readProject(cwd).catch(() => null);
    server = project ? `${slug(project.project.name)}-board` : "board";
  }
  const token = newToken();
  const claude = env.CLAUDE_BIN || "claude";
  try {
    await exec(
      claude,
      [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        scope,
        server,
        url,
        "--header",
        `Authorization: Bearer ${token}`,
      ],
      { cwd },
    );
  } catch (error) {
    // The command line holds the token: say what failed, not what ran.
    const reason = String(error.stderr ?? "")
      .trim()
      .split("\n")[0];
    throw new Error(
      `claude mcp add failed${reason ? `: ${reason}` : ""}. If "${server}" already exists, remove it with: claude mcp remove ${server} -s ${scope}`,
    );
  }
  out(
    `Added the MCP server "${server}" (${url}) to Claude Code, scope ${scope}.`,
  );
  out(
    "The token stays in this machine's Claude Code settings. Add this line to the",
  );
  out(
    "board's BOARD_MCP_TOKENS (Dokploy, comma-separated), then redeploy the board:",
  );
  out("");
  out(`  ${name}=${hashToken(token)}`);
}

async function hash({ stdin, out }) {
  const token = (await stdin()).trim();
  if (token.length < 32) throw fail("Pipe in a token of 32+ characters");
  out(hashToken(token));
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

export async function run(
  argv,
  {
    cwd = process.cwd(),
    env = process.env,
    exec = promisify(execFile),
    stdin = readStdin,
    out = console.log,
  } = {},
) {
  const { command, name, extra, options } = parseArgs(argv);
  if (extra.length) throw fail(`Unexpected argument: ${extra[0]}`);
  const context = { cwd, env, exec, stdin, out };
  if (command === "agent") return agent(checkName(name), options, context);
  if (command === "mcp") return mcp(checkName(name), options, context);
  if (command === "hash") return hash(context);
  throw fail(command ? `Unknown command: ${command}` : "Choose a command");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.usage) console.error(`\n${usage}`);
    process.exitCode = 1;
  });
