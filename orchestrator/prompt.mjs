// Renders the WORKFLOW.md prompt for one issue. Supports the subset of Liquid
// that project prompts use: {{ a.b }} and non-nested
// {% if a.b %} … {% else %} … {% endif %}.

const lookup = (scope, path) =>
  path
    .trim()
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), scope);

export function render(template, scope) {
  const conditionals = template.replace(
    /\{%-?\s*if\s+([\w.]+)\s*-?%\}([\s\S]*?)(?:\{%-?\s*else\s*-?%\}([\s\S]*?))?\{%-?\s*endif\s*-?%\}/g,
    (_, path, yes, no = "") => (lookup(scope, path) ? yes : no),
  );
  return conditionals.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = lookup(scope, path);
    return value == null ? "" : String(value);
  });
}

// Appended to Claude Code's own system prompt for every turn.
export const runtimeNotes = ({ host, labels }) => `
You run under the Project OS Claude orchestrator on the ${host === "dokploy" ? "Dokploy server" : "owner's Mac"}.
This conversation is the feature's one long-lived session: you will be resumed for
every owner message, review round and rework. Keep the issue's "## Agent Workpad"
comment current so the record survives outside this session.

- GitHub: use the \`gh\` CLI (GITHUB_TOKEN is set) wherever the workflow mentions the
  \`github_api\` tool.
- Owner messages from the board arrive as user turns that start with "[board]".
  Treat them as the owner's instructions for this feature, within the workflow's rules.
- When you need a decision only the owner can make, ask with the AskUserQuestion tool
  instead of guessing or adding "${labels.blocked ?? "blocked"}". If the owner is away
  the tool is refused; then write the question as your final message and end the turn.
  Their reply resumes this session.
- Some commands (merging, force-pushing, pushing to the default branch, deploying,
  writing outside the workspace) wait for the owner's approval on the board. If one is
  refused, do not look for another way to do the same thing.
`;

export const boardMessage = (text) => `[board] ${text}`;
