# Human gates

The owner reviews work at four gates. Each gate shows at most one page and offers
three answers: approve, revise, or stop. If the owner does not answer, agents do
not proceed past the gate; they take other ready work instead.

| Gate | Decision                        | Shown to the owner                       | Tracker signal                              | May be automated   |
| ---- | ------------------------------- | ---------------------------------------- | ------------------------------------------- | ------------------ |
| G1   | Build this idea?                | Strategist assessment card               | Idea stage → plan stage                     | No                 |
| G2   | Which features, in which order? | Feature cards with acceptance checklists | Owner adds the `ready` label                | No                 |
| G3   | Release to production?          | Staging link and release notes           | `gates.release: required` in `project.yaml` | Yes, set to `auto` |
| G4   | Publish this content?           | Content drafts before publication        | `gates.public_content: required`            | No                 |

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

Rules that hold for every project:

- Priority (Now/Next/Later) orders work. It never authorizes it.
- Only the owner adds `ready` or removes a review label.
- A blocked agent removes only `ready`, adds `blocked`, records what it needs in
  the workpad, and leaves the ticket's state unchanged.
