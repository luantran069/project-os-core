import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readProject } from "../symphony/project.mjs";
import {
  applyAction,
  createGitHub,
  createIdea,
  loadBoard,
  loadComments,
} from "./github.mjs";

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
}) {
  let cache = null;
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
        });
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

export async function main(env = process.env) {
  const manifest = await readProject();
  if (manifest.tracker?.kind !== "github")
    throw new Error("The board needs tracker.kind: github in project.yaml");
  const password = env.BOARD_PASSWORD ?? "";
  if (password.length < 12)
    throw new Error("Set BOARD_PASSWORD (at least 12 characters)");
  if (!env.GITHUB_TOKEN?.trim()) throw new Error("Set GITHUB_TOKEN");
  const repo = manifest.tracker.repo;
  const handle = createBoard({
    project: manifest.project.name,
    repo,
    labels: manifest.labels ?? {},
    password,
    secret: env.BOARD_SESSION_SECRET || randomBytes(32),
    secure: env.BOARD_INSECURE_COOKIE !== "1",
    github: createGitHub({ repo, token: env.GITHUB_TOKEN.trim() }),
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
