# Changelog

## 0.7.0 (2026-11-09)

- Several Claude orchestrators can share one board, and the owner gives each feature to
  one of them. The board takes `AGENT_TOKENS=name=token,...`; each orchestrator sets
  `AGENT_NAME` and its own `AGENT_TOKEN`. The "Phiên Claude" panel has an agent picker
  that sets the issue's `agent:<name>` label, and cards show the agent or "Chưa giao
  agent". A named agent takes only its labelled features; moving a feature stops the old
  agent, and the new one starts a new session from the issue and the workpad. See
  "Several agents" in `docs/board.md` and ADR-0002.
- A single `AGENT_TOKEN` with no `AGENT_NAME` works as before: that agent takes the
  features without an `agent:` label.
- The inbox reply names the agent. An orchestrator whose `AGENT_NAME` does not match
  stops instead of acting for another agent.
- Redeploy the board and restart the orchestrators after syncing.

## 0.6.1 (2026-11-09)

- The orchestrator's host comes from the environment. `ORCHESTRATOR_HOST` (`mac` or
  `dokploy`) overrides `runtime.host`, and the Dokploy image sets it to `dokploy`, so
  one commit runs on the Mac or on Dokploy without editing `project.yaml`. Keep
  `runtime.host: mac` as the default. Rebuild the orchestrator image after syncing.

## 0.6.0 (2026-11-07)

- A Claude orchestrator: one resumable Claude session per feature, linked to the board.
  Set `runtime.orchestrator: claude` and `runtime.host: mac` or `dokploy`; see
  `docs/orchestrator.md` and ADR-0001 in `docs/decisions/`. Symphony stays the default.
- The board gets a chat panel on every card when `AGENT_TOKEN` is set: the owner talks
  to the feature's session at any stage, answers the agent's questions, allows or denies
  held commands, and can take the session over in a terminal with `claude --resume`.
- The orchestrator only calls out to the board, so a Mac needs no open port.
- `sync-project` copies `orchestrator/` into `.project-os/orchestrator/`.
  `check-project` checks vendored files and `runtime.host` for Claude projects too.
- Redeploy the board after syncing. Without `AGENT_TOKEN` it behaves as before.

## 0.5.0 (2026-11-04)

- The board shows an agent's conversation. A runner saves the session on a
  `board-sessions` branch and links `/#session/<run id>` from the issue; the page sits
  behind the board's login and the card links to it. See "Claude sessions" in
  `docs/board.md`. The board's token needs nothing new. Redeploy the board after syncing.

## 0.4.0 (2026-11-04)

- The board takes images. Paste, drop or choose a PNG, JPEG, GIF or WebP of up to
  5 MB in a new idea or a decision note. Images are stored on a `board-images` branch
  with no shared history, shown on the card, and written into the issue as Markdown.
  The board's token needs nothing new: Contents read/write already covers it.
  Redeploy the board after syncing.
- The repository is public under the MIT license (`LICENSE`). Clone the core
  over HTTPS without a token; projects still vendor `.project-os/` with
  `sync-project`, so nothing changes for existing projects.
- Documentation is in English (README and every file in `docs/`).
- `docs/bootstrap-prompt.md`: a prompt that lets an agent set up a new project
  from an empty git repository.
- `docs/adopt-prompt.md`: the same for a repository that already has code.
- New projects no longer keep `**CORE_VERSION**`, `**PROJECT_NAME**` and
  `**DATE**` in `AGENTS.md`, `WORKFLOW.md` and `memory/state.md`. Prettier had
  rewritten these placeholders to bold, so `new-project` never replaced them; in
  Markdown they now sit in backticks, which Prettier leaves alone.
  `check-project` reports the bold form of a known placeholder, so fix any it
  finds in an existing project by hand.
- `check-project` and `sync-project` ignore line endings when they hash vendored
  files, so a CRLF checkout of the core or of a project no longer reports every
  file as edited locally. Hashes of LF files are unchanged. A project pinned from
  a CRLF core has to run `sync-project` once more.
- `sync-project` writes vendored files with LF and adds `.project-os/** text eol=lf`
  to the project's `.gitattributes`. `new-project` writes LF from a CRLF core.
- `sync-project` pins `core.version` in a CRLF `project.yaml` too.
- The core's own `.gitattributes` checks out LF on every platform.
- `check-project` names files with forward slashes on Windows.

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
