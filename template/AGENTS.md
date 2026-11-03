# Repository guidance

This project uses Project OS core `__CORE_VERSION__` (see `project.yaml`). Agent
roles, gates and the delivery playbook live in
[project-os-core](https://github.com/luantran069/project-os-core).

## Product context

Read `memory/vision.md`, `README.md` and the current ticket before implementation.
Unresolved product choices are not approved requirements. Record durable
decisions as ADRs in `memory/decisions/`.

TODO(owner): add domain rules agents must always follow (data handling, legal, tone).

## Git worktree workflow

`master` is the default and integration branch. Use an isolated Git worktree for
every task that changes repository files. Read-only investigations and reviews do
not require a worktree.

1. Run `git fetch origin`. If the original checkout is clean, switch it to
   `master` and fast-forward to `origin/master`.
2. If the checkout is dirty or the fast-forward is refused, preserve it and report
   why. Never stash, reset, discard changes, or move an existing task worktree.
3. Reuse an active task worktree when continuing its task. For new work, create a
   unique task worktree from the latest `origin/master` on a `codex/<task>` branch,
   under `.symphony/task-worktrees/<task>` when no managed worktree tool exists.
4. Install dependencies, format and verify inside that worktree.
5. Target pull requests at `master`. Never force-push or include unrelated work.
6. Keep task branches and worktrees until the owner asks to remove them.

## Working on a ticket

- Implement the ticket's acceptance criteria and keep the change small enough to review.
- Only the `ready` label from `project.yaml` authorizes implementation.
- Mirror any human or pilot review label from the ticket onto the PR and keep it
  until the owner removes it from the ticket.
- Record verification commands and results against the current PR head. Report
  any check that could not run.
- Do not invent credentials, providers, thresholds or product decisions. Block the
  ticket and record what is needed.
- When a lesson would help future work, add it to `memory/learnings.md`.

## Current verification

TODO(owner): list the commands that prove a change works, for example:

- Setup: `<install command>`
- `<verify command>`: types, unit tests, build.
- For documentation changes, review local links and run `git diff --check`.
