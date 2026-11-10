import { isAbsolute, relative, resolve } from "node:path";

// What the orchestrator does with a tool call the agent wants to make: run it,
// refuse it, or hold it until the owner answers on the board.

// Shell commands only the owner may approve. They change shared state or leave
// the feature's workspace: merging, rewriting pushed history, pushing to the
// default branch, releasing, deploying, or running as another user.
const ownerOnly = [
  [/\bgh\s+pr\s+merge\b/, "merge a pull request"],
  [
    /\bgit\s+push\b[^\n;&|]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b)/,
    "force-push",
  ],
  [
    /\bgit\s+push\b[^\n;&|]*\s(?:origin\s+)?(?:HEAD:)?(?:master|main)\b/,
    "push to the default branch",
  ],
  [/\bgh\s+release\b/, "publish a release"],
  [
    /\bgh\s+(?:repo|secret|variable)\s+(?:delete|set|edit)\b/,
    "change repository settings",
  ],
  [/\b(?:docker\s+push|dokploy|kubectl|terraform\s+apply)\b/, "deploy"],
  [/\bsudo\b/, "run as another user"],
  [/\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\$HOME)/, "delete outside the workspace"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z)?sh\b/, "run a downloaded script"],
];

const fileTools = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// A reviewer only reads and runs checks. The orchestrator acts on its verdict,
// so anything that changes the pull request, the issue or the remote is refused
// outright, without asking the owner.
const reviewerRefused = [
  ...ownerOnly,
  [/\bgit\s+push\b/, "push"],
  [
    /\bgh\s+(?:pr|issue)\s+(?:merge|close|reopen|edit|comment|review|ready|lock|delete|create|transfer)\b/,
    "change the pull request or the issue",
  ],
  [/\bgh\s+label\b/, "change labels"],
  [
    /\bgh\s+api\b[^\n;&|]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
    "write through the GitHub API",
  ],
  [
    /\bgh\s+api\b[^\n;&|]*\s(?:-f|-F|--field|--raw-field|--input)\b/,
    "write through the GitHub API",
  ],
];

const reviewerNote = (reason) =>
  `A reviewer may not ${reason}. Only read, check out and run checks; put what should change in your verdict.`;

const inside = (root, path) => {
  if (typeof path !== "string" || !path) return false;
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// Returns { behavior: "allow" }, { behavior: "ask", reason } or
// { behavior: "deny", message }. role "reviewer" never asks: it is refused.
export function decide(toolName, input = {}, { workspace, role = "coder" }) {
  if (role === "reviewer") return decideReviewer(toolName, input);
  if (toolName === "AskUserQuestion")
    return { behavior: "ask", reason: "question" };
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    for (const [pattern, reason] of ownerOnly)
      if (pattern.test(command)) return { behavior: "ask", reason };
    return { behavior: "allow" };
  }
  if (fileTools.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    return inside(workspace, path)
      ? { behavior: "allow" }
      : { behavior: "ask", reason: "write outside the workspace" };
  }
  return { behavior: "allow" };
}

function decideReviewer(toolName, input) {
  if (toolName === "AskUserQuestion")
    return {
      behavior: "deny",
      message:
        "The reviewer cannot ask the owner. If the decision is the owner's, answer with the verdict escalate and say why.",
    };
  if (fileTools.has(toolName))
    return { behavior: "deny", message: reviewerNote("edit files") };
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    for (const [pattern, reason] of reviewerRefused)
      if (pattern.test(command))
        return { behavior: "deny", message: reviewerNote(reason) };
  }
  return { behavior: "allow" };
}

// One line the owner reads on the board before answering.
export function describe(toolName, input = {}) {
  if (toolName === "Bash") return String(input.command ?? "").slice(0, 500);
  if (fileTools.has(toolName))
    return `${toolName} ${input.file_path ?? input.notebook_path ?? ""}`;
  if (toolName === "AskUserQuestion")
    return (input.questions ?? []).map((q) => q.question).join("\n");
  return `${toolName} ${JSON.stringify(input).slice(0, 300)}`;
}
