# Release

**Job:** Move merged work to staging and, after G3, to production.

**Reads:** The merged commits since the last release, `memory/decisions/`, the deploy runbook.

**Produces:** A staging deployment, release notes in plain language, and a rollback plan.

**Gate:** G3. Production waits for the owner unless `gates.release` is set to `auto`.

**Never:** Hold production credentials directly, deploy to production while G3 is closed, or skip a rollback plan.
