# ADR-0005: An AI reviewer may decide pull requests for the owner

- Status: accepted
- Date: 2026-11-10
- Decided by: Luan Tran (owner), who asked for an AI agent to review and merge pull
  requests in their place, and chose: every PR except risky areas, back to the coder at
  most twice, and `human_review` kept as the owner's way out; drafted by Claude

## Context

Every feature stops in "Chờ duyệt" until the owner reads the pull request and presses
merge. With many small features that is the slowest step, and the owner wants to spend
their review time on the risky changes only. The core already names a Reviewer role
whose rule is never to approve a pull request it wrote, and says a separate reviewer run
is a later step.

## Decision

- `gates.merge` in `project.yaml` says who decides a pull request in review: `owner`
  (the default, unchanged behaviour) or `ai`.
- With `ai`, the coder hands off with a new label, `labels.ai_review`, unless the issue
  carries `human_review` or `pilot_review`. The coder never merges.
- The orchestrator that owns the feature starts a reviewer: a fresh Claude session per
  head commit, in its own workspace and state, under a policy that refuses every edit,
  push, comment, label and merge, and that never asks the owner. It reads the ticket,
  the diff and the checks, may run the project's verification, and answers with a JSON
  verdict: approve, revise or escalate.
- The verdict is advice. Code decides, from GitHub, for the reviewed head:
  - files matching `review.owner_paths`, CI that is missing or unreadable, a draft or a
    conflict → the owner (`human_review`);
  - failing CI or "revise" → back to the coder (`ready` and a "Yêu cầu sửa PR" comment),
    at most `review.max_rounds` times (2), counted from the issue's comments; then the
    owner;
  - "escalate" → the owner;
  - "approve" with green CI → squash-merge at the reviewed SHA. A push during the review
    means the new head is reviewed instead.
- Every outcome is a comment on the issue signed "AI reviewer của `<agent>`".

## Alternatives considered

- **Let the coder merge its own PR after CI.** One session would mark its own work; the
  Reviewer role forbids that.
- **Let the reviewer run `gh pr merge` itself.** The model would hold the last check;
  with the rules in code, a confused or manipulated review can at worst send work back
  or to the owner.
- **Review on the board server.** The board has no Claude login and must stay small;
  the orchestrator already runs sessions, workspaces and the policy.

## Consequences

- PRs that pass review merge without the owner. The owner reads the audit comments, and
  any feature can still be sent back or stopped from the board.
- Each review is one more Claude session (cost); it runs with its own concurrency of one.
- The reviewer's live log is in the orchestrator's output, not in the board's chat panel.
- `owner_paths` is a list of globs the project keeps current. A risky area it does not
  list, such as new payment code, is reviewed and merged like any other change until it
  is added.
