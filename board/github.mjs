// Reads features (GitHub issues) and their pull requests for the board, and
// turns the owner's decisions into label changes, comments and merges.
import { randomBytes } from "node:crypto";

const api = "https://api.github.com";
const closingRef = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const previewRef = /^\s*preview:\s*(https:\/\/\S+)/im;
const priorities = ["now", "next", "later"];

export const columns = [
  { id: "idea", title: "Ý tưởng", gate: "G1" },
  { id: "plan", title: "Kế hoạch", gate: "G2" },
  { id: "ready", title: "Sẵn sàng" },
  { id: "running", title: "Đang làm" },
  { id: "review", title: "Chờ duyệt", gate: "PR" },
  { id: "blocked", title: "Bị chặn" },
  { id: "done", title: "Xong" },
];

const lower = (value) => String(value ?? "").toLowerCase();

// The board column for an issue, from its state and labels.
export function stageOf(issue, labels) {
  if (issue.state === "closed") return "done";
  const has = new Set((issue.labels ?? []).map((label) => lower(label.name)));
  const is = (key) => labels[key] && has.has(lower(labels[key]));
  if (is("blocked")) return "blocked";
  if (is("ready")) return is("in_progress") ? "running" : "ready";
  if (is("human_review") || is("pilot_review")) return "review";
  if (is("plan")) return "plan";
  return "idea";
}

// Issue numbers a pull request closes, from "Closes #N" in its body.
export function closedIssues(body) {
  return [...String(body ?? "").matchAll(closingRef)].map((m) => Number(m[1]));
}

export function priorityOf(issue) {
  for (const label of issue.labels ?? []) {
    const name = lower(label.name).replace(/^priority[:\s-]*/, "");
    if (priorities.includes(name)) return name;
  }
  return null;
}

function summarizeChecks(runs) {
  if (!runs.length) return "none";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  const bad = ["failure", "timed_out", "cancelled", "action_required"];
  return runs.some((run) => bad.includes(run.conclusion))
    ? "failure"
    : "success";
}

export function createGitHub({ repo, token, fetchImpl = fetch }) {
  const base = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  async function send(path, { method = "GET", body, accept } = {}) {
    const response = await fetchImpl(`${api}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "project-os-board",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === "DELETE") return null;
    if (!response.ok) {
      // Never pass GitHub's body through: it can echo request details.
      const error = new Error(
        `GitHub ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async function request(path, options) {
    const response = await send(path, options);
    return !response || response.status === 204 ? null : response.json();
  }
  async function binary(path) {
    const response = await send(path, {
      accept: "application/vnd.github.raw",
    });
    return Buffer.from(await response.arrayBuffer());
  }
  async function pages(path, limit = 10) {
    const items = [];
    for (let page = 1; page <= limit; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await request(
        `${path}${separator}per_page=100&page=${page}`,
      );
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }
  return { request, binary, pages, base };
}

// Images live on their own branch with no shared history, so they never reach
// the default branch or a build.
export const imageBranch = "board-images";
export const maxImageBytes = 5 * 1024 * 1024;
export const imageTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// The type comes from the bytes, never the file name, so a script cannot pass
// as an image.
export function imageExtension(bytes) {
  const has = (text, at = 0) =>
    bytes.subarray(at, at + text.length).equals(Buffer.from(text, "latin1"));
  if (has("\x89PNG\r\n\x1a\n")) return "png";
  if (has("\xff\xd8\xff")) return "jpg";
  if (has("GIF87a") || has("GIF89a")) return "gif";
  if (has("RIFF") && has("WEBP", 8)) return "webp";
  return null;
}

async function createImageBranch(gh, path, content, message) {
  const blob = await gh.request(`${gh.base}/git/blobs`, {
    method: "POST",
    body: { content, encoding: "base64" },
  });
  const tree = await gh.request(`${gh.base}/git/trees`, {
    method: "POST",
    body: {
      tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
    },
  });
  const commit = await gh.request(`${gh.base}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [] },
  });
  await gh.request(`${gh.base}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${imageBranch}`, sha: commit.sha },
  });
}

// Stores an image and returns the Markdown that shows it on GitHub and the board.
export async function uploadImage(gh, repo, bytes, name, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const random = randomBytes(16).toString("hex");
  const id = `${month}/${random}.${imageExtension(bytes)}`;
  const path = `images/${id}`;
  const content = bytes.toString("base64");
  const message = `Board image ${id}`;
  const branch = await gh
    .request(`${gh.base}/git/ref/heads/${imageBranch}`)
    .catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
  if (branch)
    await gh.request(`${gh.base}/contents/${path}`, {
      method: "PUT",
      body: { message, content, branch: imageBranch },
    });
  else await createImageBranch(gh, path, content, message);
  const alt =
    String(name ?? "")
      .replace(/[^\p{L}\p{N} ._-]/gu, "")
      .trim()
      .slice(0, 100) || "ảnh";
  return {
    id,
    markdown: `![${alt}](https://github.com/${repo}/blob/${imageBranch}/${path}?raw=true)`,
  };
}

export const loadImage = (gh, id) =>
  gh.binary(`${gh.base}/contents/images/${id}?ref=${imageBranch}`);

// A runner saves each Claude session on this branch, so the board can show it.
export const sessionBranch = "board-sessions";
const maxSessionText = 20_000;

const cutText = (text) =>
  text.length > maxSessionText
    ? `${text.slice(0, maxSessionText)}\n… (cắt ${text.length - maxSessionText} ký tự)`
    : text;

const blocksOf = (content) => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
};

const resultText = (content) =>
  blocksOf(content)
    .map((block) => (block.type === "text" ? block.text : "[ảnh]"))
    .join("\n");

const toolSummary = ({ description, command, file_path, pattern } = {}) =>
  String(description ?? command ?? file_path ?? pattern ?? "")
    .split("\n")[0]
    .slice(0, 120);

// A session file has one JSON record per line. The Action's execution file holds
// the same records as one array.
function sessionRecords(text) {
  const parse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  const whole = text.trimStart().startsWith("[") ? parse(text) : null;
  return Array.isArray(whole) ? whole : text.split("\n").map(parse);
}

// The messages of a session in order, with each tool's result beside its call.
export function parseSession(text) {
  const entries = [];
  const tools = new Map();
  for (const record of sessionRecords(text)) {
    if (!["user", "assistant"].includes(record?.type) || record.isMeta)
      continue;
    const at = record.timestamp;
    for (const block of blocksOf(record.message?.content)) {
      if (block.type === "text" && block.text)
        entries.push({ kind: record.type, text: block.text, at });
      else if (block.type === "thinking" && block.thinking)
        entries.push({ kind: "thinking", text: block.thinking, at });
      else if (block.type === "tool_use") {
        const tool = {
          kind: "tool",
          name: block.name,
          summary: toolSummary(block.input),
          input: cutText(JSON.stringify(block.input ?? {}, null, 2)),
          result: null,
          error: false,
          at,
        };
        tools.set(block.id, tool);
        entries.push(tool);
      } else if (block.type === "tool_result") {
        let tool = tools.get(block.tool_use_id);
        if (!tool) {
          tool = { kind: "tool", name: "", summary: "", input: "", at };
          entries.push(tool);
        }
        tool.result = cutText(resultText(block.content));
        tool.error = Boolean(block.is_error);
      }
    }
  }
  return entries;
}

export const loadSession = async (gh, run) =>
  parseSession(
    (
      await gh.binary(
        `${gh.base}/contents/sessions/${run}.jsonl?ref=${sessionBranch}`,
      )
    ).toString("utf8"),
  );

async function pullDetails(gh, pull) {
  const sha = pull.head?.sha;
  const [checks, deployments] = await Promise.all([
    sha
      ? gh
          .request(`${gh.base}/commits/${sha}/check-runs?per_page=100`)
          .then((r) => summarizeChecks(r.check_runs ?? []))
          .catch(() => "unknown")
      : "unknown",
    sha
      ? gh
          .request(`${gh.base}/deployments?sha=${sha}&per_page=5`)
          .catch(() => [])
      : [],
  ]);
  let preview = String(pull.body ?? "").match(previewRef)?.[1] ?? null;
  for (const deployment of preview ? [] : deployments) {
    const statuses = await gh
      .request(`${gh.base}/deployments/${deployment.id}/statuses?per_page=1`)
      .catch(() => []);
    const url = statuses[0]?.environment_url;
    if (statuses[0]?.state === "success" && url?.startsWith("https://")) {
      preview = url;
      break;
    }
  }
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.merged_at ? "merged" : pull.state,
    draft: Boolean(pull.draft),
    sha,
    checks,
    preview,
  };
}

// Every open feature, the most recently closed ones, and their pull requests.
export async function loadBoard(gh, labels, { closedLimit = 20 } = {}) {
  const [open, closed, pulls] = await Promise.all([
    gh.pages(`${gh.base}/issues?state=open&sort=updated&direction=desc`),
    gh.request(
      `${gh.base}/issues?state=closed&sort=updated&direction=desc&per_page=${closedLimit}`,
    ),
    gh.pages(`${gh.base}/pulls?state=all&sort=updated&direction=desc`, 1),
  ]);
  const issues = [...open, ...closed].filter((issue) => !issue.pull_request);
  const byIssue = new Map();
  for (const pull of pulls)
    for (const number of closedIssues(pull.body))
      if (!byIssue.has(number)) byIssue.set(number, pull);
  const features = await Promise.all(
    issues.map(async (issue) => {
      const pull = byIssue.get(issue.number);
      return {
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        body: issue.body ?? "",
        stage: stageOf(issue, labels),
        priority: priorityOf(issue),
        labels: (issue.labels ?? []).map((label) => label.name),
        updated: issue.updated_at,
        comments: issue.comments ?? 0,
        pull:
          pull && (pull.state === "open" || issue.state === "open")
            ? await pullDetails(gh, pull)
            : pull
              ? {
                  number: pull.number,
                  url: pull.html_url,
                  state: pull.merged_at ? "merged" : pull.state,
                }
              : null,
      };
    }),
  );
  return { columns, features };
}

export async function loadComments(gh, number) {
  const comments = await gh.pages(`${gh.base}/issues/${number}/comments`, 3);
  return comments.map((comment) => ({
    author: comment.user?.login ?? "",
    created: comment.created_at,
    body: comment.body ?? "",
    workpad: /^\s*##\s*Agent Workpad/i.test(comment.body ?? ""),
  }));
}

// What each button does in each column: labels to add and remove, whether to
// merge the pull request or close the issue. Unlisted pairs are refused.
export function planAction(stage, action, labels) {
  const L = labels;
  const plans = {
    idea: {
      approve: {
        add: [L.plan],
        remove: [L.idea],
        verb: "Duyệt G1: lập kế hoạch",
      },
      revise: { add: [], remove: [], verb: "Yêu cầu sửa ý tưởng" },
      stop: { close: "not_planned", remove: [], add: [], verb: "Dừng ý tưởng" },
    },
    plan: {
      approve: { add: [L.ready], remove: [L.plan], verb: "Duyệt G2: cho làm" },
      revise: { add: [], remove: [], verb: "Yêu cầu sửa kế hoạch" },
      stop: { close: "not_planned", remove: [], add: [], verb: "Dừng feature" },
    },
    ready: {
      stop: { add: [], remove: [L.ready, L.in_progress], verb: "Tạm dừng" },
    },
    running: {
      stop: { add: [], remove: [L.ready, L.in_progress], verb: "Tạm dừng" },
    },
    review: {
      approve: {
        merge: true,
        add: [],
        remove: [L.human_review, L.pilot_review, L.in_progress],
        verb: "Duyệt PR: merge",
      },
      revise: {
        add: [L.ready],
        remove: [L.human_review, L.pilot_review, L.in_progress],
        verb: "Yêu cầu sửa PR",
      },
      stop: {
        add: [],
        remove: [L.human_review, L.pilot_review, L.in_progress],
        close: "not_planned",
        verb: "Dừng feature",
      },
    },
    blocked: {
      approve: {
        add: [L.ready],
        remove: [L.blocked],
        verb: "Gỡ chặn: làm tiếp",
      },
      revise: {
        add: [L.ready],
        remove: [L.blocked],
        verb: "Gỡ chặn kèm ghi chú",
      },
      stop: {
        add: [],
        remove: [L.blocked],
        close: "not_planned",
        verb: "Dừng feature",
      },
    },
  };
  const plan = plans[stage]?.[action];
  if (!plan) return null;
  return {
    ...plan,
    add: plan.add.filter(Boolean),
    remove: plan.remove.filter(Boolean),
  };
}

export async function applyAction(gh, labels, number, action, note = "") {
  const issue = await gh.request(`${gh.base}/issues/${number}`);
  if (issue.pull_request)
    throw Object.assign(new Error("Not a feature"), { status: 400 });
  const stage = stageOf(issue, labels);
  const plan = planAction(stage, action, labels);
  if (!plan)
    throw Object.assign(new Error(`Không làm được "${action}" ở cột này`), {
      status: 409,
    });
  if (action === "revise" && !note.trim())
    throw Object.assign(new Error("Cần ghi chú khi yêu cầu sửa"), {
      status: 400,
    });
  let merged = null;
  if (plan.merge) {
    const pulls = await gh.pages(
      `${gh.base}/pulls?state=open&sort=updated&direction=desc`,
      1,
    );
    const pull = pulls.find((p) => closedIssues(p.body).includes(number));
    if (!pull)
      throw Object.assign(
        new Error("Không tìm thấy PR đang mở có Closes #" + number),
        { status: 409 },
      );
    const result = await gh.request(`${gh.base}/pulls/${pull.number}/merge`, {
      method: "PUT",
      body: { merge_method: "squash", sha: pull.head.sha },
    });
    merged = { number: pull.number, sha: result?.sha ?? null };
  }
  const lines = [`**${plan.verb}** (chủ dự án, từ board)`];
  if (merged) lines.push(`Đã merge PR #${merged.number}.`);
  if (note.trim()) lines.push("", note.trim());
  await gh.request(`${gh.base}/issues/${number}/comments`, {
    method: "POST",
    body: { body: lines.join("\n") },
  });
  const present = new Set((issue.labels ?? []).map((l) => lower(l.name)));
  for (const label of plan.remove)
    if (present.has(lower(label)))
      await gh.request(
        `${gh.base}/issues/${number}/labels/${encodeURIComponent(label)}`,
        { method: "DELETE" },
      );
  if (plan.add.length)
    await gh.request(`${gh.base}/issues/${number}/labels`, {
      method: "POST",
      body: { labels: plan.add },
    });
  if (plan.close || merged)
    await gh.request(`${gh.base}/issues/${number}`, {
      method: "PATCH",
      body: {
        state: "closed",
        state_reason: merged ? "completed" : plan.close,
      },
    });
  return { stage, action, merged };
}

export async function createIdea(gh, labels, title, body = "") {
  const issue = await gh.request(`${gh.base}/issues`, {
    method: "POST",
    body: { title, body, labels: [labels.idea].filter(Boolean) },
  });
  return { number: issue.number, url: issue.html_url };
}
