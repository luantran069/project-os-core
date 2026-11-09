import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readProject } from "../symphony/project.mjs";
import {
  applyAction,
  assignAgent,
  assignedAgent,
  createGitHub,
  createIdea,
  imageExtension,
  imageTypes,
  loadBoard,
  loadComments,
  loadImage,
  loadSession,
  maxImageBytes,
  uploadImage,
} from "./github.mjs";
import { agentName, createRelay } from "./relay.mjs";

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
}) {
  let cache = null;
  // Agent name -> token. "" is the unnamed agent of a single AGENT_TOKEN,
  // which takes every feature that has no `agent:` label.
  const tokens = { ...agentTokens, ...(agentToken ? { "": agentToken } : {}) };
  const named = Object.keys(tokens).filter(Boolean).sort();
  // Set when the board is linked to at least one Claude orchestrator.
  const relay = Object.keys(tokens).length ? createRelay({ now }) : null;
  const caller = (header = "") => {
    let found = null;
    for (const [name, token] of Object.entries(tokens))
      if (same(header, `Bearer ${token}`)) found = name;
    return found;
  };
  // The agent that should receive commands for a feature.
  async function agentFor(number) {
    const issue = await github.request(`${github.base}/issues/${number}`);
    const assigned = assignedAgent(issue);
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
      if (route === "GET /api/board") {
        if (
          !cache ||
          now() - cache.at > cacheMs ||
          url.searchParams.has("fresh")
        )
          cache = { at: now(), data: await loadBoard(github, labels) };
        return send(response, 200, {
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
        });
      }
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
        const agent = await agentFor(issue);
        if (!chat[2]) {
          const text = String(body.text ?? "").trim();
          if (!text || text.length > 20_000)
            return send(response, 400, {
              error: "Cần nội dung tin nhắn (tối đa 20.000 ký tự)",
            });
          relay.push(agent, { type: "message", issue, text });
        } else if (chat[2] === "answer") {
          const answers = Object.fromEntries(
            Object.entries(body.answers ?? {})
              .slice(0, 4)
              .map(([q, a]) => [
                String(q).slice(0, 1000),
                String(a).slice(0, 5000),
              ]),
          );
          relay.push(agent, {
            type: "answer",
            issue,
            id: String(body.id ?? "").slice(0, 64),
            allow: body.allow !== false,
            answers,
            note: String(body.note ?? "").slice(0, 5000),
          });
        } else relay.push(agent, { type: chat[2], issue });
        return send(response, 202, {
          ok: true,
          agent,
          online: relay.online(agent),
        });
      }
      const assign = url.pathname.match(/^\/api\/features\/(\d+)\/agent$/);
      if (request.method === "POST" && assign) {
        if (!named.length)
          return send(response, 404, {
            error: "Board chưa có agent nào có tên",
          });
        const { agent } = await readJson(request);
        if (!named.includes(agent))
          return send(response, 400, { error: "Không có agent này" });
        const issue = Number(assign[1]);
        const result = await assignAgent(github, issue, agent);
        // The old agent stops at once instead of on its next tracker pass.
        if (result.before && result.before in tokens && result.changed)
          relay.push(result.before, { type: "unassigned", issue });
        cache = null;
        return send(response, 200, { agent, ...result });
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
        if (!["approve", "revise", "stop"].includes(body.action))
          return send(response, 400, { error: "Hành động không hợp lệ" });
        const result = await applyAction(
          github,
          labels,
          Number(action[1]),
          body.action,
          String(body.note ?? "").slice(0, 5000),
        );
        cache = null;
        return send(response, 200, result);
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
        cache = null;
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

// AGENT_TOKENS="luan-mac=<token>,friend-mac=<token>": one token per agent, so
// each can be told apart and revoked on its own.
export function parseAgentTokens(text) {
  const tokens = {};
  for (const pair of String(text)
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const token = pair.slice(at + 1).trim();
    if (at < 1 || !agentName.test(name))
      throw new Error(
        `AGENT_TOKENS: "${name || pair.slice(0, 20)}" is not a valid agent name (a-z, 0-9, -)`,
      );
    if (token.length < 32)
      throw new Error(
        `AGENT_TOKENS: the token for ${name} needs 32+ characters`,
      );
    if (name in tokens) throw new Error(`AGENT_TOKENS: ${name} appears twice`);
    if (Object.values(tokens).includes(token))
      throw new Error("AGENT_TOKENS: each agent needs its own token");
    tokens[name] = token;
  }
  return tokens;
}

export async function main(env = process.env) {
  const manifest = await readProject();
  if (manifest.tracker?.kind !== "github")
    throw new Error("The board needs tracker.kind: github in project.yaml");
  const password = env.BOARD_PASSWORD ?? "";
  if (password.length < 12)
    throw new Error("Set BOARD_PASSWORD (at least 12 characters)");
  if (!env.GITHUB_TOKEN?.trim()) throw new Error("Set GITHUB_TOKEN");
  const agentToken = env.AGENT_TOKEN ?? "";
  if (agentToken && agentToken.length < 32)
    throw new Error("AGENT_TOKEN must be at least 32 characters");
  const agentTokens = parseAgentTokens(env.AGENT_TOKENS ?? "");
  const repo = manifest.tracker.repo;
  const handle = createBoard({
    project: manifest.project.name,
    repo,
    labels: manifest.labels ?? {},
    password,
    secret: env.BOARD_SESSION_SECRET || randomBytes(32),
    secure: env.BOARD_INSECURE_COOKIE !== "1",
    github: createGitHub({ repo, token: env.GITHUB_TOKEN.trim() }),
    agentToken,
    agentTokens,
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
