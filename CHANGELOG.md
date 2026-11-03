# Changelog

## Unreleased

- The repository is public under the MIT license (`LICENSE`). Clone the core
  over HTTPS without a token; projects still vendor `.project-os/` with
  `sync-project`, so nothing changes for existing projects.

## 0.3.1 (2026-11-01)

- `symphony:probe` sends the pinned `github_api` tool for GitHub projects instead
  of always the Jira tool, matching what Symphony v0.0.3 sends.

## 0.3.0 (2026-10-30)

Features can live in GitHub Issues instead of Jira, as the data source for the
project's own board.

- `tracker.kind: github` in `project.yaml` (with `tracker.repo`) is the default for
  new projects. Symphony v0.0.3 polls open issues of that repo; stages are labels.
- New label `labels.in_progress` (`symphony-in-progress`), added by the agent when
  it starts so the board can tell ready work from running work.
- `symphony/check.mjs` checks either tracker; `--live` for GitHub reads the
  repository, its labels and the open-issue poll without writing.
- `symphony:service install` copies only `GITHUB_TOKEN` for GitHub projects.
- Template `WORKFLOW.md` uses GitHub issues: workpad comment, review hand-off by
  label, PR body starts with `Closes #N`. `new-project` no longer takes
  `--tracker-key`.
- Jira projects keep working unchanged until they migrate.
- New `board/` module: the owner's feature board (zero-dependency Node server
  and page, password login). Columns follow the gates; buttons approve, ask for
  changes or stop, and leave a comment on the issue; approving a review merges
  the PR at the shown head. Deployed from `.project-os/board/Dockerfile`; see
  `docs/board.md`.
- `symphony/migrate-jira.mjs` (`npm run symphony:migrate-jira`): one-time,
  dry-run-first move of a Jira project's open tickets into GitHub issues with
  stage labels, roadmap priority, comments and blockers; done tickets go to
  `docs/jira-archive.md`. See `docs/migrate-from-jira.md`.
- `sync-project` now vendors every core module (`symphony/`, `board/`) under
  `.project-os/<module>/`.

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
