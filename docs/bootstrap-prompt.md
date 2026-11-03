# Bootstrap prompt for a new project

Open Claude Code or Codex **inside the new project directory** (after `git init`,
still empty) and paste the block below. Fill in the first line, or leave the
placeholders and the agent will ask.

```text
App name: <App Name>   GitHub repo: <owner>/<repo>   Project owner: <Owner Name>

Task: turn the current directory (an empty git repository) into a project running on
Project OS core. The core is the public repository
https://github.com/luantran069/project-os-core and needs no token to clone.

Work in this order and stop to ask me if a step fails:

1. Check that the current directory is a git repository with nothing but .git in it.
   If other files exist, stop and tell me (an existing codebase needs a manual merge).
   Check Node >= 22.18 (`node -v`).
2. Clone the core into a temporary directory outside this repository and run `npm ci`
   there. Read the core's README.md, docs/architecture.md, docs/symphony.md and
   gates/README.md before going on. Note the core version (VERSION file).
3. Generate the skeleton into another temporary directory (new-project refuses a
   directory that contains .git):
   node <core>/scripts/new-project.mjs <tmp>/skeleton --name "<App Name>" --repo <owner>/<repo> --owner "<Owner Name>"
   Copy everything in <tmp>/skeleton/. into the current directory without overwriting.
4. Run `npm install` in this repository to create package-lock.json (the worker runs `npm ci`).
5. Run `node <core>/scripts/check-project.mjs .` and fix until it passes. List every
   remaining TODO(owner) item.
6. Ask me at most 5 short questions to draft memory/vision.md (problem, audience,
   success measure, what it will not do, market). Write the draft and mark it
   "Draft, pending owner confirmation". Do not invent a vision I have not given.
7. Make one commit on the default branch: "Bootstrap on Project OS core <version>"
   (including .project-os/). Do NOT push, create a GitHub repository or create tokens.
   Never commit a .env file or any secret.
8. Report briefly: files created, the check-project result, remaining TODO(owner)
   items, and the steps left for me: create the GitHub repository and push, enable
   Issues, create the symphony-* and priority-* labels, create a fine-grained token for
   this repository only (Issues read/write, Metadata read) for Symphony, install the
   worker per the core's docs/symphony.md, and optionally the board per docs/board.md.

Rules: never edit files under .project-os/ by hand (sync-project owns them). Write all
files and documentation in English.
```

After the agent finishes: read its report, edit `memory/vision.md`, then do the
GitHub steps it lists.
