# Project OS core

A shared core for starting software projects run by a team of AI agents. Agents
plan in detail, write code, test and hand over. The project owner only approves
at four gates: direction, feature plan, release and public content.

Current version: see [`VERSION`](VERSION). Core v0 was extracted from the
workflow running in good-ideas (a private repository; Symphony + Codex + Jira),
with the parts specific to Investment Storylines removed.

This repository is public under the [MIT](LICENSE) license. Every machine (a
laptop, the worker host, a Claude session) gets the core with a plain `git clone`,
no token needed:

```bash
git clone https://github.com/luantran069/project-os-core.git
```

Never commit tokens, `.env` files or project-specific information here. Anything
project-specific (host paths, accounts, data) lives in that project's repository.

All documentation in this repository is written in English.

## Core and projects

Projects do **not** fork the core. A project is created from
[`template/`](template/) and records the core version it uses in `project.yaml`.
When the core releases a new version, each project decides when to upgrade, like
updating a library.

```
project-os-core/          this repository
  agents/                 agent roles: job, inputs, outputs, permission limits
  gates/                  the four approval gates and their tracker labels
  playbooks/              shared lessons, drawn from projects
  template/               skeleton for a new project
  symphony/               orchestrator: runs an agent per feature (GitHub Issues)
  board/                  the owner's board: follow features, approve gates
  scripts/                create a project, sync the core into it, check it
  docs/                   architecture, Symphony, board, migration guides

my-app/                   a project created from the template
  project.yaml            core version, modules on/off, autonomy levels, budget
  AGENTS.md               working rules for agents in this repository
  WORKFLOW.md             Symphony configuration and the coding agent prompt
  memory/                 vision, decisions, state, learnings
  docs/idea-planning-template.md
  marketing/brand.md
  .project-os/            copy of the core's symphony/ and board/, written by sync-project, never edited by hand
```

## Starting a new project

Requires Node 22.18 or later. Clone the core (command above) and run `npm ci` in
it once.

```bash
node scripts/new-project.mjs ../my-app \
  --name "My App" --repo luantran069/my-app --owner "Luan Tran"
node scripts/check-project.mjs ../my-app
```

This also copies the Symphony orchestrator into the project's
`.project-os/symphony/`. When the core releases a new version, run
`node scripts/sync-project.mjs ../my-app` to update.

`new-project` refuses a directory that is not empty, and a directory after
`git init` counts as not empty. In that case generate into a temporary directory
and copy the files in, or hand the work to an agent with the
[bootstrap prompt](docs/bootstrap-prompt.md).

Then open `../my-app/memory/vision.md` and write the vision. It is the only file a
person must write; agents read it before anything else.

## The four gates

| Gate | Question              | What you review                              | Can it be automated?        |
| ---- | --------------------- | -------------------------------------------- | --------------------------- |
| G1   | Should we build this? | The Strategist's assessment                  | No                          |
| G2   | Which feature first?  | Short feature cards with acceptance criteria | No                          |
| G3   | Ship to production?   | Staging build and release notes              | Yes, once tests are trusted |
| G4   | Publish this?         | Posts, ads, videos before they go public     | No                          |

Details and the matching tracker labels: [`gates/README.md`](gates/README.md).

## Documentation

- [Architecture](docs/architecture.md): lifecycle, agents, autonomy levels, memory.
- [Symphony in the core](docs/symphony.md): orchestration commands, how projects receive and pin them.
- [Project board](docs/board.md): what the board shows and how to deploy it.
- [Moving from Jira to GitHub Issues](docs/migrate-from-jira.md).
- [Bootstrap prompt](docs/bootstrap-prompt.md): let an agent set up a new project from an empty repository.
- [Moving good-ideas onto the core](docs/adopting-good-ideas.md): what was
  extracted, what stays in good-ideas, next steps.
- [Agent roles](agents/README.md).
- [Playbooks](playbooks/README.md).

## Testing the core

```bash
npm test
```

Runs the tests for the create, sync and check scripts and for the Symphony files.
