# Symphony in the core

Symphony is the Project OS orchestrator. It reads the project's tracker (GitHub
Issues since core 0.3.0, or Jira for projects that have not moved), hands each
approved feature to a Codex agent running in its own clone of the repository, and
archives the workspace when the ticket is done. The Symphony control code lives in
[`symphony/`](../symphony/) of the core; projects do not write it themselves.

## What the core provides

| File           | Command in the project     | What it does                                                                                                              |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `runtime.json` | —                          | Pins Symphony v0.0.3 and the SHA-256 of each platform build.                                                              |
| `setup.mjs`    | `npm run symphony:setup`   | Downloads the pinned Symphony build into `.symphony/bin` and verifies the checksum.                                       |
| `check.mjs`    | `npm run symphony:check`   | Checks `WORKFLOW.md` against the core contract and `project.yaml`. Add `-- --live` to check the real tracker (read only). |
| `probe.mjs`    | `npm run symphony:probe`   | Starts `codex app-server` on the worker host without running a turn.                                                      |
| `codex.mjs`    | (called by Symphony)       | Bridge to Codex; opens write access only to the ticket's own `.git`.                                                      |
| `archive.mjs`  | (`before_remove` hook)     | Keeps the ticket's repository and worktrees under `.symphony/archives`.                                                   |
| `start.mjs`    | `npm run symphony:start`   | Runs the live checks, then starts Symphony with `WORKFLOW.md`.                                                            |
| `service.mjs`  | `npm run symphony:service` | Installs and controls the worker's systemd user service.                                                                  |
| `project.mjs`  | —                          | Reads `project.yaml` and `WORKFLOW.md`; shared by the files above.                                                        |

Run every command from the project root. The service name and the directory that
holds the tracker credentials come from `project.name`, for example "Investment
Storylines" becomes `investment-storylines-symphony.service` and
`~/.config/investment-storylines/`.

## How a project receives these files

`scripts/sync-project.mjs <project>` copies `symphony/` into the project's
`.project-os/symphony/`, records hashes in `.project-os/core.json` and pins
`core.version` in `project.yaml`. The project commits these files, so the worker,
Docker and ticket clones never need to fetch the core. It also adds
`.project-os/** text eol=lf` to the project's `.gitattributes`, so these files stay
LF on every platform; the recorded hashes ignore line endings either way.

Do not edit files under `.project-os/` in a project. `check-project` fails when a
file differs from its recorded hash. To change one, change it in the core, bump
the version and sync again.

## What the project declares

In `project.yaml`:

- `tracker.kind`: `github` (default for new projects) or `jira`; must match
  `WORKFLOW.md`.
- For GitHub: `tracker.repo` must match `tracker.provider.repo`, the token is read
  from an environment variable (`token: $GITHUB_TOKEN`), states are `open` /
  `closed`, and the labels `labels.in_progress` and `labels.human_review` are
  required. For Jira: `tracker.project_key`.
- `runtime.max_concurrent_agents`, `runtime.max_turns`: must match `WORKFLOW.md`.
- `runtime.setup_command` (for example `npm ci`): must appear in the
  `after_create` hook.
- `runtime.verify_command` (for example `npm run verify`): must appear in the
  agent prompt.
- `labels.*`: the `ready` label must be in `required_labels`; the `blocked` and
  `pilot_review` labels must be mentioned in the prompt.

Fixed by the core: the tracker states (GitHub: `open`, `closed`; Jira:
`Ready for delivery`, `Delivery`, `Impact`, `Done`), the command
`node .project-os/symphony/codex.mjs`, the archive hook, and the monitoring port
listening only on `127.0.0.1`.

## GitHub Issues

Symphony v0.0.3 reads every open issue of `tracker.repo` every 30 seconds and
dispatches only issues with the `ready` label. The agent updates the issue through
Symphony's `github_api` tool, which uses the same token as the reader. How stages
map to labels is described in [gates/README.md](../gates/README.md#github-issues-tracker).

Token: a fine-grained token for the project repository only, with Issues
read/write and Metadata read. Put `GITHUB_TOKEN=...` in a source file and run
`npm run symphony:service -- install --env-source <file> ...`; only this variable
is copied into the service. `npm run symphony:check -- --live` checks the
repository, that Issues are enabled, that every label in `project.yaml` exists,
and counts ready issues, without writing to GitHub. The agent still pushes code
and opens pull requests with the worker host's SSH key and `gh`, as before.
