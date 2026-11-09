import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// One JSON file per feature under <dir>/features/: the Claude session id, the
// workspace it runs in, and where the conversation stands. Session transcripts
// themselves stay where Claude Code keeps them (~/.claude/projects/).
//
// status:
//   new            no session yet
//   running        a turn is in progress
//   idle           the last turn ended; the owner can write at any time
//   waiting-owner  the agent asked something and ended its turn
//   taken-over     the owner continues by hand; the orchestrator stays out
//   reassigned     the feature went to another agent; this one stays out
//   failed         the last turn ended with an error
export const statuses = [
  "new",
  "running",
  "idle",
  "waiting-owner",
  "taken-over",
  "reassigned",
  "failed",
];

export function createStore(dir) {
  const folder = join(dir, "features");
  mkdirSync(folder, { recursive: true });
  const file = (issue) => join(folder, `${Number(issue)}.json`);
  const blank = (issue) => ({
    issue: Number(issue),
    status: "new",
    sessionId: null,
    workspace: null,
    question: null,
    turns: 0,
    costUsd: 0,
    updatedAt: null,
  });
  function get(issue) {
    try {
      return {
        ...blank(issue),
        ...JSON.parse(readFileSync(file(issue), "utf8")),
      };
    } catch (error) {
      if (error.code === "ENOENT") return blank(issue);
      throw error;
    }
  }
  function update(issue, patch, now = new Date()) {
    const next = { ...get(issue), ...patch, updatedAt: now.toISOString() };
    const tmp = `${file(issue)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file(issue));
    return next;
  }
  function list() {
    return readdirSync(folder)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => get(Number(name.slice(0, -5))));
  }
  // A turn cannot survive a restart: its process is gone. Keep the session so
  // the next message resumes it.
  function recover() {
    for (const record of list())
      if (record.status === "running")
        update(record.issue, {
          status: "idle",
          note: "orchestrator restarted",
        });
  }
  return { get, update, list, recover };
}
