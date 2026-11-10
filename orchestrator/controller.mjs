import { assignedAgent, stageOf } from "../board/github.mjs";
import { boardMessage, render } from "./prompt.mjs";

// Connects the owner's commands and the tracker to the feature sessions.
//
// - `ready` on an open issue starts (or, after rework, resumes) its session with
//   the WORKFLOW.md prompt. That is still the only thing that starts
//   implementation, and only the owner adds it.
// - A chat message from the board resumes the session at any stage. Before
//   `ready` the agent may read, discuss and refine the plan, but not build.
// - With several agents, each takes only the features labelled
//   `agent:<its name>`. An agent without a name takes only unlabelled ones.
//   When a feature moves to another agent, this one stops.

export const discussionPrompt = (
  issue,
  stage,
  labels,
) => `[board] The owner opened a conversation about feature #${issue.number} "${issue.title}" (board stage: ${stage}).
It is not approved for implementation: it has no "${labels.ready}" label.
Read AGENTS.md, memory/vision.md, memory/decisions/ and the issue with its comments
(\`gh issue view ${issue.number} --comments\`). Discuss, read the code, and propose or refine
the plan. Do not create branches, commits or pull requests until the owner adds
"${labels.ready}". Edit the issue body only when the owner asks you to write the plan there.`;

const issueScope = (issue) => ({
  identifier: `#${issue.number}`,
  number: issue.number,
  title: issue.title,
  state: issue.state,
  url: issue.html_url,
  description: issue.body ?? "",
});

export function createController({
  gh,
  labels,
  store,
  runner,
  workspaces,
  workflowPrompt,
  agent = null,
  // With gates.merge: ai, the reviewer takes features handed off for AI review.
  reviewer = null,
  log = console.error,
}) {
  const mine = (issue) => assignedAgent(issue) === (agent || null);
  const hasReady = (issue) =>
    (issue.labels ?? []).some(
      (label) =>
        String(label.name).toLowerCase() === String(labels.ready).toLowerCase(),
    );

  const workflowTurn = (issue, attempt) =>
    render(workflowPrompt, { issue: issueScope(issue), attempt });

  async function startWork(issue) {
    const record = store.get(issue.number);
    const dispatches = (record.dispatches ?? 0) + 1;
    const workspace = await workspaces.prepare(issue.number);
    store.update(issue.number, { dispatchedReady: true, dispatches });
    runner.send(
      issue.number,
      workflowTurn(issue, dispatches > 1 ? dispatches : null),
      { workspace },
    );
  }

  // One pass over the tracker: start features that just got `ready`, and note
  // the ones that lost it so a later `ready` (rework) resumes them.
  async function tick() {
    const open = (await gh.pages(`${gh.base}/issues?state=open`, 5)).filter(
      (i) => !i.pull_request,
    );
    const byNumber = new Map(open.map((i) => [i.number, i]));
    // Features given to another agent since the last pass.
    for (const record of store.list()) {
      const issue = byNumber.get(record.issue);
      if (issue && !mine(issue) && record.status !== "reassigned")
        runner.detach(record.issue);
    }
    const ready = new Map(
      open.filter((i) => hasReady(i) && mine(i)).map((i) => [i.number, i]),
    );
    for (const record of store.list())
      if (record.dispatchedReady && !ready.has(record.issue))
        store.update(record.issue, { dispatchedReady: false });
    for (const issue of ready.values()) {
      const record = store.get(issue.number);
      if (
        record.dispatchedReady ||
        record.status === "taken-over" ||
        runner.busy(issue.number)
      )
        continue;
      try {
        await startWork(issue);
      } catch (error) {
        log(`Could not start #${issue.number}: ${error.message}`);
      }
    }
    if (reviewer) await reviewer.tick(open.filter(mine));
  }

  async function message(number, text) {
    const record = store.get(number);
    if (record.sessionId && record.status !== "reassigned")
      return runner.send(number, boardMessage(text));
    // First contact: give the new session its bearings, then the message.
    const issue = await gh.request(`${gh.base}/issues/${number}`);
    if (issue.pull_request) throw new Error(`#${number} is a pull request`);
    if (!mine(issue))
      throw new Error(
        `#${number} is assigned to ${assignedAgent(issue) ?? "no agent"}`,
      );
    const workspace = await workspaces.prepare(number);
    const ready = issue.state === "open" && hasReady(issue);
    const intro = ready
      ? workflowTurn(issue, null)
      : discussionPrompt(issue, stageOf(issue, labels), labels);
    if (ready)
      store.update(number, {
        dispatchedReady: true,
        dispatches: (record.dispatches ?? 0) + 1,
      });
    runner.send(number, `${intro}\n\n${boardMessage(text)}`, { workspace });
  }

  async function handle(command) {
    const issue = Number(command?.issue);
    if (!Number.isInteger(issue) || issue <= 0)
      throw new Error("command without an issue");
    switch (command.type) {
      case "message":
        return message(issue, String(command.text ?? "").slice(0, 20_000));
      case "answer":
        return runner.answer(issue, String(command.id), command);
      case "takeover":
        return runner.takeOver(issue);
      case "release":
        return runner.release(issue);
      case "unassigned":
        return runner.detach(issue);
      default:
        throw new Error(`unknown command ${command.type}`);
    }
  }

  return { tick, handle };
}
