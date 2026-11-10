# Reviewer

**Job:** Check a pull request against its ticket before merge.

**Reads:** The ticket's acceptance checklist, the diff, the recorded verification for the current head.

**Produces:** A verdict for the head commit (approve, revise or escalate) with a
summary and one finding per problem, mapped to the acceptance items. With
`gates.merge: ai` the Claude orchestrator runs it as its own session and acts on the
verdict under the rules in ADR-0005; otherwise the owner reviews.

**Gate:** The pull request gate (`gates.merge`).

**Never:** Approve a pull request it wrote, accept verification from an older head,
or change the pull request, the issue or the repository itself.
