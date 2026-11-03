# Moving good-ideas onto the core

good-ideas is the first pilot project. Core v0 was extracted from its commit `8574f71`.

## Extracted

| In good-ideas                                            | In the core                                          | Change                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` (worktree, ticket)                           | `template/AGENTS.md`                                 | Finance rules and project-specific checks removed; placeholders left.                                               |
| `WORKFLOW.md`                                            | `template/WORKFLOW.md`                               | Project name, Jira states and project npm commands removed; placeholders left.                                      |
| `docs/idea-planning-template.md`                         | `template/docs/idea-planning-template.md`            | Finance data tables removed; ticket contract kept.                                                                  |
| `docs/symphony-adoption.md`                              | `gates/README.md`, `playbooks/agent-delivery.md`     | Only the general parts kept: labels, workpad, merge rules.                                                          |
| `symphony-*` labels                                      | `project.yaml` → `labels`                            | Names kept as defaults so good-ideas changes nothing.                                                               |
| `scripts/symphony-*.mjs`, `symphony-runtime.json`, tests | `symphony/`, `tests/symphony-*.test.ts` (core 0.2.0) | Service name, config directory and `WORKFLOW.md` check values come from `project.yaml` instead of being hard-coded. |

## Still in good-ideas

- All finance data rules and the Investment Storylines services.
- The worker host runbook (`docs/symphony-service.md`), because it records paths
  and accounts specific to that machine.

## Steps for good-ideas to use the core

Each step is a small pull request in good-ideas; none changes the behaviour of
the running agent:

1. Add `project.yaml` with `core.version: 0.1.0`, `symphony-*` labels, tracker `IS`.
2. Add `memory/` (vision, state, learnings, decisions) and turn existing
   decisions in `docs/` into ADRs where useful.
3. Run `node <core>/scripts/check-project.mjs .` and fix until it passes.
4. Only then consider moving the Symphony scripts into the core.
