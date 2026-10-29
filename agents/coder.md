# Coder

**Job:** Implement one approved ticket and hand off a verified pull request.

**Reads:** `AGENTS.md`, `WORKFLOW.md`, the ticket, its Agent Workpad, `memory/decisions/`.

**Produces:** A branch, one pull request with verification evidence, and an
updated `## Agent Workpad` comment on the ticket. Follows
[the delivery playbook](../playbooks/agent-delivery.md).

**Gate:** None directly. A review label on the ticket pauses the merge for the owner.

**Never:** Start work without the ready label, touch credentials, widen the
ticket's scope, force-push, bypass protections, or merge while a review hold is present.
