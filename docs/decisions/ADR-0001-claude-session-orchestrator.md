# ADR-0001: A Claude session per feature, driven from the board

- Status: proposed
- Date: 2026-11-07
- Decided by: Luan Tran (owner), drafted by Claude

## Context

The board turns the owner's decisions into labels. Symphony polls those labels every
30 seconds, starts `codex app-server` for a `ready` issue, runs up to eight turns with
no approvals and throws the thread away. That gives three limits the owner hit:

1. **No real session.** Nobody can open the agent's conversation and keep talking to
   it. "Request changes" adds a comment and the `ready` label, and the next run is a
   new agent that rebuilds its context from the workpad.
2. **One direction only.** The agent cannot ask the owner anything. Its only way out
   is `blocked`, which ends the run. Risky steps are either forbidden or silently
   allowed; nothing waits for a yes.
3. **Nothing reacts.** Only labels start work. A chat message, a review comment or a
   failed check does not reach the agent.

Core 0.5.0 already lets the board _show_ a saved Claude session, but nothing writes
one and the page is read-only.

The owner runs the agent on their Mac today and wants the same setup to run on a
Dokploy VPS by choice.

## Decision

Add an `orchestrator/` module that replaces Symphony when `runtime.orchestrator` is
`claude`. It uses the Claude Agent SDK and keeps **one resumable session per
feature**.

- **Session per feature.** The first run creates a session in the feature's workspace
  and stores its id. Every later message resumes it (`resume: <id>`), so the agent
  keeps what it read, decided and tried. The session lives in `~/.claude/projects/`
  on the orchestrator's host, like any Claude Code session.
- **Chat from the board.** Each card gets a chat panel. A message goes to that
  feature's session; replies, tool calls and the result stream back to the panel.
  Owner and agent can talk at any stage, including while the PR is open.
- **Take over in a terminal.** The panel shows the exact command to continue the
  session by hand (`cd <workspace> && claude --resume <id>`). "Take over" pauses the
  orchestrator for that feature until the owner hands it back.
- **Two-way by design.** The agent has an `ask_owner` tool. Calling it ends the turn
  and moves the feature to "waiting for owner"; the reply resumes the same session.
  Tool calls that the policy marks as owner-only (merging, force-pushing, deploying,
  writing outside the workspace) wait for an allow or deny in the panel instead of
  being refused.
- **The orchestrator calls out; the board never calls in.** The orchestrator
  long-polls the board for owner messages and posts events back, with a shared
  `AGENT_TOKEN`. The host therefore needs no open port, which is what lets the same
  code run on either host:

  | `runtime.host` | Orchestrator runs            | Board runs               | Claude login                                     |
  | -------------- | ---------------------------- | ------------------------ | ------------------------------------------------ |
  | `mac`          | On the owner's Mac           | Dokploy, or locally      | The Mac's own `claude` login                     |
  | `dokploy`      | A Dokploy app (`Dockerfile`) | The same Dokploy project | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |

- **What stays.** GitHub Issues remain the source of truth. Gates G1, G2 and the PR
  gate and the label names do not change. Each feature still gets its own clone, its
  own `codex/<issue>` worktree and one `## Agent Workpad` comment. `ready` is still
  the only label that starts implementation, and only the owner adds it.

## Alternatives considered

- **Keep Symphony and add a chat on top.** Symphony owns the Codex thread and does not
  keep it, so there is nothing to resume. Chat would still mean a new agent each time.
- **`anthropics/claude-code-action` in GitHub Actions.** Good for one-shot runs and the
  0.5.0 viewer, but every run is a fresh runner. Resuming means shipping session files
  between runs, and the owner cannot attach a terminal to it.
- **The board calls the orchestrator.** Simpler, but a Mac behind NAT would need a
  tunnel and an open port. Calling out avoids both.
- **Spawn `claude -p --resume` per message.** Works, but the SDK gives typed events,
  `canUseTool` for owner approvals and in-process tools without parsing CLI output.

## Consequences

- Easier: continuing a PR by chatting; the agent asking before it guesses; seeing a
  run live instead of after it ends; moving between Mac and VPS by changing one field.
- Harder: the orchestrator now holds state (session ids, pending approvals) in its
  state directory, which must survive restarts and be backed up on Dokploy.
- The board's relay queue is in memory. A board restart drops unsent owner messages
  and the live event buffer; the session itself is not affected.
- A session resumed by hand while the orchestrator also resumes it would split the
  history. "Take over" exists to prevent that; the orchestrator refuses to run a
  taken-over feature.
- Cost moves from Codex to Claude. `budget.monthly_usd` should be set before raising
  `max_concurrent_agents`; the orchestrator records each turn's cost.
- Not in this first version: routing review comments and failed checks into the
  session, separate planner and reviewer sessions, and a launchd service for the Mac.
  Each fits the same event path and is a later change.
