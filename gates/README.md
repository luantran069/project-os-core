# Human gates

The owner reviews work at four gates. Each gate shows at most one page and offers
three answers: approve, revise, or stop. If the owner does not answer, agents do
not proceed past the gate; they take other ready work instead.

| Gate | Decision                        | Shown to the owner                       | Tracker signal                              | May be automated   |
| ---- | ------------------------------- | ---------------------------------------- | ------------------------------------------- | ------------------ |
| G1   | Build this idea?                | Strategist assessment card               | `idea` label → `plan` label                 | No                 |
| G2   | Which features, in which order? | Feature cards with acceptance checklists | Owner adds the `ready` label                | No                 |
| G3   | Release to production?          | Staging link and release notes           | `gates.release: required` in `project.yaml` | Yes, set to `auto` |
| G4   | Publish this content?           | Content drafts before publication        | `gates.public_content: required`            | No                 |
| PR   | Merge this pull request?        | The pull request, its diff and checks    | `human_review` label; `gates.merge`         | Yes, set to `ai`   |

## Labels

Label names come from `project.yaml` so an existing project keeps its names. The
defaults match good-ideas:

| Key in `project.yaml` | Default label           | Meaning                                                     |
| --------------------- | ----------------------- | ----------------------------------------------------------- |
| `labels.idea`         | `symphony-idea`         | Idea stage. No implementation.                              |
| `labels.plan`         | `symphony-plan`         | Plan stage. No implementation.                              |
| `labels.ready`        | `symphony-ready`        | G2 passed. The only label that authorizes implementation.   |
| `labels.blocked`      | `symphony-blocked`      | Agent stopped for a missing decision, dependency or access. |
| `labels.human_review` | `symphony-human-review` | Pause before merge; the owner reviews the pull request.     |
| `labels.pilot_review` | `symphony-pilot-review` | Same pause, used while trialling a new workflow.            |
| `labels.ai_review`    | `symphony-ai-review`    | Waiting for the AI reviewer (`gates.merge: ai`).            |

Rules that hold for every project:

- Priority (Now/Next/Later) orders work. It never authorizes it.
- Only the owner adds `ready` or removes a review label. With `gates.merge: ai` the
  AI reviewer also does both, for features handed off with `ai_review` (ADR-0005 in
  `docs/decisions/`).
- A blocked agent removes only `ready`, adds `blocked`, records what it needs in
  the workpad, and leaves the ticket's state unchanged.

## GitHub Issues tracker

From core 0.3.0 a project can keep its features in GitHub Issues
(`tracker.kind: github`). An issue is only open or closed, so every stage is a
label on an open issue:

| Stage                 | Labels                                 | Agent runs |
| --------------------- | -------------------------------------- | ---------- |
| Idea (waiting for G1) | `idea`                                 | No         |
| Plan (waiting for G2) | `plan`                                 | No         |
| Ready                 | `ready`                                | Yes        |
| In progress           | `ready`, `in_progress`                 | Yes        |
| Waiting for review    | `human_review`, without `ready`        | No         |
| Waiting for AI review | `ai_review`, without `ready`           | Reviewer   |
| Blocked               | `blocked`, without `ready`             | No         |
| Done                  | issue closed (the PR says `Closes #N`) | No         |

Removing `ready` stops a running agent at the next poll. Rework is the owner
adding `ready` again to the same issue, so the branch, PR and workpad carry on.
GitHub has no "blocked by" link that Symphony reads: the owner adds `ready` to a
dependent feature only after its dependency is closed.

## The pull request gate

`gates.merge` decides who merges:

- `owner` (default): the coder hands off with `human_review` and the owner merges from
  the board.
- `ai`: the coder hands off with `ai_review`. The Claude orchestrator starts a separate
  reviewer session for the head commit and acts on its verdict under fixed rules: a PR
  touching `review.owner_paths`, without readable green CI, in draft or with conflicts
  goes to the owner; failing CI or "revise" goes back to the coder at most
  `review.max_rounds` times; "approve" squash-merges the reviewed SHA. `human_review` or
  `pilot_review` on the issue keeps the decision with the owner. See
  [the orchestrator docs](../docs/orchestrator.md#ai-reviewer).
