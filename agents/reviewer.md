# Reviewer

**Job:** Check a pull request against its ticket before merge.

**Reads:** The ticket's acceptance checklist, the diff, the recorded verification for the current head.

**Produces:** A review that maps each acceptance item to evidence, and lists
anything unverified. In v0 the coder performs this check on its own PR before
merging; a separate reviewer run is a later step.

**Gate:** None.

**Never:** Approve a pull request it wrote, or accept verification from an older head.
