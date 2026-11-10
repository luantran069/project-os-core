import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { workflowTurn } from "../orchestrator/prompt.mjs";
import { parseWorkflow, readProject } from "../symphony/project.mjs";
import {
  applyAction,
  assignAgent,
  assignedAgent,
  chatAgent,
  chatPromptSection,
  claimFeature,
  createGitHub,
  createIdea,
  defaultStaleHours,
  imageExtension,
  imageTypes,
  isChatAgent,
  loadBoard,
  loadComments,
  loadImage,
  loadSession,
  loadWorkflowText,
  maxImageBytes,
  uploadImage,
} from "./github.mjs";
import { createMcp } from "./mcp.mjs";
import { createRelay } from "./relay.mjs";
import { callerOf, checkDistinct, checkToken, parseTokens } from "./tokens.mjs";

const page = fileURLToPath(new URL("./index.html", import.meta.url));
const cookieName = "board_session";
const sessionDays = 30;
const cacheMs = 15_000;

const hmac = (secret, value) =>
  createHmac("sha256", secret).update(value).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signSession(secret, now = Date.now()) {
  const expires = String(now + sessionDays * 86_400_000);
  return `${expires}.${hmac(secret, expires)}`;
}

export function validSession(secret, value, now = Date.now()) {
  const [expires, signature] = String(value ?? "").split(".");
  return (
    Boolean(expires && signature) &&
    Number(expires) > now &&
    same(signature, hmac(secret, expires))
  );
}

const cookies = (header = "") =>
  Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key]) => key)
      .map(([key, ...rest]) => [key, rest.join("=")]),
  );

async function readJson(request, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

// Builds the request handler. Everything except the login form needs the
// session cookie; writes also need the JSON content type and the board's own
// header, so a cross-site form cannot trigger them.
export function createBoard({
  project,
  repo,
  labels,
  password,
  secret = randomBytes(32),
  github,
  secure = true,
  now = Date.now,
  agentToken = "",
  agentTokens = {},
  mcpToken = "",
  mcpTokens = {},
  version = "0",
  staleHours = defaultStaleHours,
  orchestrator = "claude",
}) {
  let cache = null;
  // Agent name -> token. "" is the unnamed agent of a single AGENT_TOKEN,
  // which takes every feature that has no `agent:` label.
  const tokens = { ...agentTokens, ...(agentToken ? { "": agentToken } : {}) };
  const named = Object.keys(tokens).filter(Boolean).sort();
  // Set when the board is linked to at least one Claude orchestrator.
  const relay = Object.keys(tokens).length ? createRelay({ now }) : null;
  const caller = (header = "") => callerOf(tokens, header);
  // The owner's chat holds a feature: it has no orchestrator session.
  const noSession = (number, name) =>
    Object.assign(
      new Error(
        `Feature #${number} do chat \`${name}\` của chủ dự án làm: không có phiên orchestrator nào. Xem Agent Workpad trên issue, hoặc giao feature cho một agent bằng assign_agent.`,
      ),
      { status: 409, chat: name },
    );
  // The agent that should receive commands for a feature.
  async function agentFor(number) {
    const issue = await github.request(`${github.base}/issues/${number}`);
    const assigned = assignedAgent(issue);
    if (isChatAgent(assigned)) throw noSession(number, assigned);
    if (assigned && assigned in tokens) return assigned;
    if (assigned)
      throw Object.assign(
        new Error(`Agent "${assigned}" chưa được khai báo trên board`),
        { status: 409 },
      );
    if ("" in tokens) return "";
    throw Object.assign(new Error("Feature này chưa được giao cho agent nào"), {
      status: 409,
    });
  }
  // What the page and the MCP endpoint share.
  const invalidate = () => {
    cache = null;
  };
  async function overview(fresh) {
    if (!cache || now() - cache.at > cacheMs || fresh)
      cache = {
        at: now(),
        data: await loadBoard(github, labels, { staleHours, now }),
      };
    return {
      project,
      repo,
      loadedAt: new Date(cache.at).toISOString(),
      ...cache.data,
      agent: relay
        ? {
            online: relay.online(),
            agents: named.map((name) => ({
              name,
              online: relay.online(name),
            })),
            unnamed: "" in tokens,
            features: relay.summary(),
          }
        : null,
    };
  }
  // A command for the feature's agent: a message, an answer, take over.
  async function command(issue, body) {
    // A chat feature answers so before anything else.
    const agent = await agentFor(issue);
    if (!relay)
      throw Object.assign(new Error("Board chưa nối orchestrator"), {
        status: 404,
      });
    relay.push(agent, { ...body, issue });
    return { ok: true, agent, online: relay.online(agent) };
  }
  // The orchestrator that had a feature stops at once instead of on its next
  // tracker pass. Without a label it was the unnamed agent's, if that one
  // reported a session for it.
  function stopOld(issue, before) {
    const old =
      before ??
      (relay?.view(issue).state?.agent === "" && "" in tokens ? "" : null);
    if (old !== null && old in tokens)
      relay.push(old, { type: "unassigned", issue });
  }
  // A named orchestrator, or the owner's chat (`chat`, `chat-<suffix>`),
  // which needs no token: every chat uses the MCP token.
  async function assign(issue, agent, actor) {
    const chat = isChatAgent(agent);
    if (!chat && !named.length)
      throw Object.assign(new Error("Board chưa có agent nào có tên"), {
        status: 404,
      });
    if (!chat && !named.includes(agent))
      throw Object.assign(new Error("Không có agent này"), { status: 400 });
    if (chat) refuseSymphony();
    const result = await assignAgent(github, issue, agent, actor);
    if (result.changed) stopOld(issue, result.before);
    invalidate();
    return { agent, chat, ...result };
  }
  // Symphony reads only the ready label, so it would run a chat's feature too.
  function refuseSymphony() {
    if (orchestrator === "symphony")
      throw Object.assign(
        new Error(
          "Dự án chạy Symphony, vốn không đọc nhãn agent:, nên chat không giữ riêng được feature",
        ),
        { status: 409 },
      );
  }
  // The owner's chat takes a ready feature and gets the prompt an agent
  // would: the rendered WORKFLOW.md from the default branch.
  async function claim(issue, suffix, actor) {
    const agent = chatAgent(suffix);
    refuseSymphony();
    // Read the prompt first, so a missing WORKFLOW.md changes nothing.
    const { prompt: template } = parseWorkflow(
      await loadWorkflowText(github).catch((error) => {
        if (error.status === 404)
          throw Object.assign(
            new Error("Không đọc được WORKFLOW.md trên nhánh chính"),
            { status: 409 },
          );
        throw error;
      }),
    );
    const result = await claimFeature(github, labels, issue, agent, actor);
    if (result.changed) stopOld(issue, result.before);
    invalidate();
    return {
      number: issue,
      agent,
      before: result.before,
      stage: "running",
      staleHours,
      prompt: `${workflowTurn(template, result.issue)}${chatPromptSection(labels, issue, agent)}`,
    };
  }
  // A feature's orchestrator session, or why a chat feature has none.
  async function sessionFor(issue, after = 0) {
    const agent = assignedAgent(
      await github.request(`${github.base}/issues/${issue}`),
    );
    if (isChatAgent(agent))
      return {
        number: issue,
        agent,
        chat: true,
        session: null,
        message: noSession(issue, agent).message,
      };
    return relay?.view(issue, after) ?? null;
  }
  async function decide(issue, action, note, actor) {
    if (!["approve", "revise", "stop"].includes(action))
      throw Object.assign(new Error("Hành động không hợp lệ"), { status: 400 });
    const result = await applyAction(
      github,
      labels,
      issue,
      action,
      note,
      actor,
    );
    invalidate();
    return result;
  }
  const mcp = createMcp({
    tokens: { ...mcpTokens, ...(mcpToken ? { "": mcpToken } : {}) },
    version,
    board: {
      github,
      labels,
      project,
      repo,
      overview,
      invalidate,
      session: (issue, after = 0) => relay?.view(issue, after) ?? null,
      sessionFor,
      staleHours,
      now,
      command,
      assign,
      claim,
      decide,
    },
  });
  const failures = { count: 0, until: 0 };
  const send = (response, status, body, headers = {}) => {
    const json = typeof body !== "string";
    response.writeHead(status, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      "Content-Type": json
        ? "application/json; charset=utf-8"
        : "text/html; charset=utf-8",
      ...headers,
    });
    response.end(json ? JSON.stringify(body) : body);
  };
  const sessionCookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  return async function handle(request, response) {
    const url = new URL(request.url, "http://board.local");
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === "GET /healthz") return send(response, 200, { ok: true });
      if (route === "GET /")
        return send(response, 200, await readFile(page, "utf8"));
      // The owner's AI: its own bearer token, never the owner's cookie.
      if (url.pathname === "/mcp") {
        if (!mcp) return send(response, 404, { error: "Không có" });
        return await mcp(request, response, { readJson, send });
      }
      // The orchestrator's link: a bearer token, never the owner's cookie.
      if (url.pathname.startsWith("/api/agent/")) {
        if (!relay) return send(response, 404, { error: "Không có" });
        const agent = caller(request.headers.authorization);
        if (agent === null) return send(response, 401, { error: "Cần token" });
        if (route === "GET /api/agent/inbox") {
          const wait =
            Math.min(
              Math.max(Number(url.searchParams.get("wait")) || 0, 0),
              25,
            ) * 1000;
          const closed = new Promise((resolve) =>
            response.on("close", resolve),
          );
          const commands = await relay.take(agent, wait, closed);
          // The orchestrator hung up while waiting: keep its commands.
          if (response.destroyed) return relay.restore(agent, commands);
          // The name lets an orchestrator check it uses its own token.
          return send(response, 200, { agent, commands });
        }
        if (route === "POST /api/agent/events") {
          relay.receive(agent, await readJson(request, 2 * 1024 * 1024));
          return send(response, 200, { ok: true });
        }
        return send(response, 404, { error: "Không có" });
      }
      if (route === "POST /api/login") {
        if (now() < failures.until)
          return send(response, 429, { error: "Thử lại sau ít phút" });
        const { password: given } = await readJson(request, 4096);
        if (!same(given ?? "", password)) {
          failures.count += 1;
          if (failures.count >= 5) {
            failures.until = now() + 5 * 60_000;
            failures.count = 0;
          }
          return send(response, 401, { error: "Sai mật khẩu" });
        }
        failures.count = 0;
        return send(
          response,
          200,
          { ok: true },
          {
            "Set-Cookie": sessionCookie(
              signSession(secret, now()),
              sessionDays * 86_400,
            ),
          },
        );
      }
      if (
        !validSession(
          secret,
          cookies(request.headers.cookie)[cookieName],
          now(),
        )
      )
        return send(response, 401, { error: "Cần đăng nhập" });
      if (route === "POST /api/logout")
        return send(
          response,
          200,
          { ok: true },
          {
            "Set-Cookie": sessionCookie("", 0),
          },
        );
      if (request.method === "POST") {
        const type = request.headers["content-type"] ?? "";
        if (
          !type.startsWith("application/json") ||
          request.headers["x-board"] !== "1"
        )
          return send(response, 403, { error: "Yêu cầu không hợp lệ" });
      }
      if (route === "GET /api/board")
        return send(
          response,
          200,
          await overview(url.searchParams.has("fresh")),
        );
      if (route === "POST /api/images") {
        // Base64 makes the request about a third larger than the image.
        const body = await readJson(
          request,
          Math.ceil((maxImageBytes * 4) / 3) + 4096,
        );
        const bytes = Buffer.from(String(body.data ?? ""), "base64");
        if (bytes.length > maxImageBytes)
          return send(response, 413, { error: "Ảnh tối đa 5 MB" });
        if (!imageExtension(bytes))
          return send(response, 400, {
            error: "Chỉ nhận ảnh PNG, JPEG, GIF hoặc WebP",
          });
        return send(
          response,
          201,
          await uploadImage(github, repo, bytes, body.name),
        );
      }
      const image = url.pathname.match(
        /^\/api\/images\/(\d{4}-\d{2}\/[a-f0-9]{32}\.(png|jpg|gif|webp))$/,
      );
      if (request.method === "GET" && image) {
        const bytes = await loadImage(github, image[1]);
        response.writeHead(200, {
          ...securityHeaders,
          "Cache-Control": "private, max-age=604800, immutable",
          "Content-Type": imageTypes[image[2]],
        });
        return response.end(bytes);
      }
      const session = url.pathname.match(/^\/api\/sessions\/(\d{1,20})$/);
      if (request.method === "GET" && session) {
        const entries = await loadSession(github, session[1]).catch((error) => {
          if (error.status === 404) return null;
          throw error;
        });
        if (!entries)
          return send(response, 404, { error: "Không có phiên Claude này" });
        return send(response, 200, {
          project,
          repo,
          run: session[1],
          entries,
        });
      }
      const chat = url.pathname.match(
        /^\/api\/features\/(\d+)\/chat(?:\/(answer|takeover|release))?$/,
      );
      if (chat) {
        if (!relay)
          return send(response, 404, { error: "Board chưa nối orchestrator" });
        const issue = Number(chat[1]);
        if (request.method === "GET" && !chat[2])
          return send(
            response,
            200,
            relay.view(issue, Number(url.searchParams.get("after")) || 0),
          );
        if (request.method !== "POST")
          return send(response, 404, { error: "Không có" });
        const body = await readJson(request);
        let sent;
        if (!chat[2]) {
          const text = String(body.text ?? "").trim();
          if (!text || text.length > 20_000)
            return send(response, 400, {
              error: "Cần nội dung tin nhắn (tối đa 20.000 ký tự)",
            });
          sent = { type: "message", text };
        } else if (chat[2] === "answer") {
          const answers = Object.fromEntries(
            Object.entries(body.answers ?? {})
              .slice(0, 4)
              .map(([q, a]) => [
                String(q).slice(0, 1000),
                String(a).slice(0, 5000),
              ]),
          );
          sent = {
            type: "answer",
            id: String(body.id ?? "").slice(0, 64),
            allow: body.allow !== false,
            answers,
            note: String(body.note ?? "").slice(0, 5000),
          };
        } else sent = { type: chat[2] };
        return send(response, 202, await command(issue, sent));
      }
      const pick = url.pathname.match(/^\/api\/features\/(\d+)\/agent$/);
      if (request.method === "POST" && pick) {
        const { agent } = await readJson(request);
        return send(response, 200, await assign(Number(pick[1]), agent));
      }
      const comments = url.pathname.match(/^\/api\/features\/(\d+)\/comments$/);
      if (request.method === "GET" && comments)
        return send(
          response,
          200,
          await loadComments(github, Number(comments[1])),
        );
      const action = url.pathname.match(/^\/api\/features\/(\d+)\/actions$/);
      if (request.method === "POST" && action) {
        const body = await readJson(request);
        return send(
          response,
          200,
          await decide(
            Number(action[1]),
            body.action,
            String(body.note ?? "").slice(0, 5000),
          ),
        );
      }
      if (route === "POST /api/features") {
        const body = await readJson(request);
        const title = String(body.title ?? "").trim();
        if (!title || title.length > 200)
          return send(response, 400, {
            error: "Cần tên ý tưởng (tối đa 200 ký tự)",
          });
        const created = await createIdea(
          github,
          labels,
          title,
          String(body.body ?? "").slice(0, 20_000),
        );
        invalidate();
        return send(response, 201, created);
      }
      return send(response, 404, { error: "Không có" });
    } catch (error) {
      const status = error.status && error.status < 500 ? error.status : 502;
      return send(response, status, {
        error: error.status ? error.message : "Lỗi khi gọi GitHub",
      });
    }
  };
}

// AGENT_TOKENS="luan-mac=<token>,friend-mac=sha256:<hex>": one token per
// agent, so each can be told apart and revoked on its own. A sha256:
// fingerprint (from board/token.mjs) keeps the token itself off the board.
export function parseAgentTokens(text) {
  const tokens = parseTokens(text, "AGENT_TOKENS");
  for (const name of Object.keys(tokens))
    if (isChatAgent(name))
      throw new Error(
        `AGENT_TOKENS: "${name}" is reserved for the owner's chat, which needs no agent token`,
      );
  checkDistinct({ AGENT_TOKENS: Object.values(tokens) });
  return tokens;
}

// Every token setting of the board, checked: each value a token of 32+
// characters or its fingerprint, and no two alike across agents and AIs.
export function readTokens(env = {}) {
  const one = (name) => (env[name]?.trim() ? checkToken(env[name], name) : "");
  const agentToken = one("AGENT_TOKEN");
  const agentTokens = parseAgentTokens(env.AGENT_TOKENS);
  const mcpToken = one("BOARD_MCP_TOKEN");
  const mcpTokens = parseTokens(env.BOARD_MCP_TOKENS, "BOARD_MCP_TOKENS");
  checkDistinct({
    "AGENT_TOKEN and AGENT_TOKENS": [agentToken, ...Object.values(agentTokens)],
    "BOARD_MCP_TOKEN and BOARD_MCP_TOKENS": [
      mcpToken,
      ...Object.values(mcpTokens),
    ],
  });
  return { agentToken, agentTokens, mcpToken, mcpTokens };
}

export async function main(env = process.env) {
  const manifest = await readProject();
  if (manifest.tracker?.kind !== "github")
    throw new Error("The board needs tracker.kind: github in project.yaml");
  const password = env.BOARD_PASSWORD ?? "";
  if (password.length < 12)
    throw new Error("Set BOARD_PASSWORD (at least 12 characters)");
  if (!env.GITHUB_TOKEN?.trim()) throw new Error("Set GITHUB_TOKEN");
  const tokens = readTokens(env);
  const repo = manifest.tracker.repo;
  const staleHours = Number(
    manifest.runtime?.chat?.stale_hours ?? defaultStaleHours,
  );
  if (!(staleHours > 0))
    throw new Error("project.yaml runtime.chat.stale_hours must be above 0");
  const handle = createBoard({
    project: manifest.project.name,
    repo,
    labels: manifest.labels ?? {},
    password,
    secret: env.BOARD_SESSION_SECRET || randomBytes(32),
    secure: env.BOARD_INSECURE_COOKIE !== "1",
    github: createGitHub({ repo, token: env.GITHUB_TOKEN.trim() }),
    ...tokens,
    version: String(manifest.core?.version ?? "0"),
    staleHours,
    orchestrator: manifest.runtime?.orchestrator ?? "claude",
  });
  const port = Number(env.PORT ?? 8080);
  createServer(handle).listen(port, env.HOST ?? "0.0.0.0", () =>
    console.log(`Board for ${repo} on port ${port}`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`Board cannot start: ${error.message}`);
    process.exitCode = 1;
  });
