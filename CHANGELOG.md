# Changelog

## 0.2.0 (2026-10-30)

Symphony becomes part of the core instead of living in each project.

- Move the Symphony scripts and their tests from good-ideas into `symphony/`.
  Service name, credential directory, tracker key, agent limits, setup and
  verify commands now come from `project.yaml` instead of being hard-coded.
- Add `scripts/sync-project.mjs`: copies `symphony/` into a project's
  `.project-os/symphony/`, records hashes in `.project-os/core.json` and pins
  `core.version`. `new-project` runs it.
- `check-project` now parses YAML, fails on locally edited or out-of-date
  vendored files, and checks `WORKFLOW.md` against the contract.
- Template: `package.json` with the `symphony:*` scripts, `.gitignore`, the
  archive hook and `node .project-os/symphony/codex.mjs` in `WORKFLOW.md`,
  `runtime.setup_command` and `runtime.verify_command` in `project.yaml`.
- Requires Node 22.18 or newer and the `yaml` package.

## 0.1.0 (2026-10-29)

First version, extracted from the agent workflow in good-ideas at `8574f71`.

- Agent role contracts: strategist, planner, coder, reviewer, release, marketer, analyst, librarian.
- Four human gates and the tracker label mapping, with good-ideas label names as defaults.
- Project template: `project.yaml`, `AGENTS.md`, Symphony `WORKFLOW.md`, memory layout, ticket template, brand file.
- Agent delivery playbook from the good-ideas Symphony pilot.
- `scripts/new-project.mjs` and `scripts/check-project.mjs`, with tests.
