# ADR-0002: Several orchestrators on one board, one agent per feature

- Status: accepted
- Date: 2026-11-09
- Decided by: Luan Tran (owner), drafted by Claude

## Context

ADR-0001 gave each feature one Claude session run by one orchestrator. The owner now has
more than one machine that can run Claude (their Mac, a friend's Mac, Dokploy) and wants
to send each feature to a chosen one. A session lives on the machine that made it, so a
feature must belong to exactly one agent at a time.

## Decision

- Each orchestrator has a name (`AGENT_NAME`) and its own token. The board maps tokens to
  names (`AGENT_TOKENS`) and trusts only the token, never a name in a request body.
- The assignment is the issue's `agent:<name>` label, set from the board. It lives in the
  tracker with the rest of the feature's state, survives restarts and shows on GitHub.
- A named agent takes only features labelled with its name. A feature with no label
  waits for the owner; nothing claims it on its own.
- Moving a feature stops the old agent and the new one starts a new session from the
  issue and its Agent Workpad. Sessions are not copied between machines.
- An unnamed `AGENT_TOKEN` keeps the 0.6 behaviour for boards with one orchestrator.

## Alternatives considered

- **First free agent claims unassigned features.** Faster, but two agents could claim
  the same feature between passes, and the owner does not choose. Rejected by the owner.
- **Copy the session to the new machine.** Possible by moving the `.jsonl` file, but the
  workspace and its git state would have to move too. The workpad already carries what
  the next agent needs.
- **Assignment stored only on the board.** Lost when the board restarts, and invisible
  on GitHub.

## Consequences

- The owner decides which machine works on what, and can move work when a machine is off.
- A moved feature loses its conversation history; the workpad must stay current.
- Every agent needs its own Claude login, GitHub token and repository access.
