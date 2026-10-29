# Idea planning template

Use this to turn an idea into a ticket an agent can execute. An idea or plan does
not authorize implementation; only the `ready` label from `project.yaml` does.

## Stages

| Stage          | Tracker state and labels              | Action                                                       |
| -------------- | ------------------------------------- | ------------------------------------------------------------ |
| Idea           | Parking lot + `idea`, without `ready` | Describe the problem and outcome. No implementation.         |
| Plan           | Discovery + `plan`, without `ready`   | Specify scope, acceptance, dependencies, verification.       |
| Approved (G2)  | Ready for delivery + `ready`          | Owner approves the contract below.                           |
| Implementation | Delivery + `ready`                    | Agent implements, verifies and keeps one workpad and one PR. |
| Review         | Impact                                | Inactive. Owner reviews when a review label is present.      |
| Rework         | Back to Delivery + `ready`            | Same branch, PR and workpad.                                 |
| Complete       | Done after a verified merge           | Ticket closes only once GitHub reports the merge.            |

## Copy into the ticket description

### Problem

- Who meets the problem, and when: `<user and trigger>`
- Current behaviour and evidence: `<observation and source>`
- Why it matters: `<impact>`

### User-visible outcome

`<What the user can do or see after this change.>`

### Scope and non-goals

- Included: `<behaviour, files, contracts>`
- Not included: `<deliberately out of scope>`
- Must keep working: `<what existing users rely on>`

### Acceptance checklist

- [ ] Given `<starting state>`, when `<action>`, then `<visible result>`.
- [ ] `<Failure or missing-input behaviour is observable>`.
- [ ] `<Existing behaviour still works>`.
- [ ] `<Docs or operating instructions updated, or not applicable because ...>`.

### Dependencies and blockers

| Dependency or missing input | Linked issue or evidence | Needed resolution | Owner and next action |
| --------------------------- | ------------------------ | ----------------- | --------------------- |
| `<item>`                    | `<key or source>`        | `<resolution>`    | `<who, what>`         |

Write `None` when there are none. Do not add `ready` while a decision or access is
missing. Credentials never go in the ticket, workpad, PR or repository.

### Approved decisions

List decisions and data sources this ticket relies on, who approved them and when.
Separate approved requirements from suggestions and open questions.

### Verification

| Acceptance item | Command or manual procedure | Expected evidence |
| --------------- | --------------------------- | ----------------- |
| `<item>`        | `<command>`                 | `<result>`        |

### Approval

- Owner approval: `<who, date>`
- Open questions: `<list or None>`
- Review checkpoint: `<human_review, pilot_review, or none>`
