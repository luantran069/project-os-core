# Adopt prompt for an existing project

Use this when the repository already has code. Open Claude Code or Codex **inside
that repository** on a clean working tree and paste the block below. Fill in the
first line, or leave the placeholders and the agent will ask.

```text
App name: <App Name>   GitHub repo: <owner>/<repo>   Project owner: <Owner Name>

Task: put the current repository, which already has code, on Project OS core without
breaking anything it does today. The core is the public repository
https://github.com/luantran069/project-os-core and needs no token to clone.

Work in this order and stop to ask me if a step fails or a choice is unclear:

1. Check that the working tree is clean and Node >= 22.18. Create a branch
   `project-os/adopt`. Survey the repository: language, package manager, how to
   install, test, lint and build, existing AGENTS.md / WORKFLOW.md / CI, and whether it
   already uses Jira or Symphony. Summarise this before changing anything.
2. Clone the core into a temporary directory outside this repository and run `npm ci`
   there. Read the core's README.md, docs/architecture.md, docs/symphony.md and
   gates/README.md. Note the core version (VERSION file).
3. Generate a skeleton into another temporary directory (new-project refuses a
   non-empty directory):
   node <core>/scripts/new-project.mjs <tmp>/skeleton --name "<App Name>" --repo <owner>/<repo> --owner "<Owner Name>"
4. Bring the skeleton in without overwriting anything:
   - Copy files the repository does not have: project.yaml, memory/,
     docs/idea-planning-template.md, marketing/brand.md (only if marketing is on).
   - AGENTS.md exists: merge by hand, keep every existing rule, add the skeleton's
     worktree and ticket sections.
   - WORKFLOW.md exists: merge by hand; the skeleton is the contract check compares against.
   - package.json exists: add the `symphony:*` scripts, the `yaml` dependency and
     `engines.node >= 22.18`; change nothing else.
   - .gitignore exists: append the skeleton's lines that are missing.
   Never delete or rewrite existing code, config or docs.
5. Fit project.yaml and WORKFLOW.md to the real repository:
   - runtime.setup_command = the real install command (npm ci, pnpm install
     --frozen-lockfile, ...), identical to the one in the WORKFLOW.md after_create hook.
   - runtime.verify_command = the existing test/lint/build command, and mention it in
     the WORKFLOW.md prompt.
   - modules.build.autonomy: L1 if this app runs in production.
   - tracker: github by default; if the project uses Jira, keep tracker.kind: jira and
     tell me about docs/migrate-from-jira.md instead of migrating.
6. Run `node <core>/scripts/sync-project.mjs .` then `node <core>/scripts/check-project.mjs .`
   and fix until it passes. Run the install command so the lockfile is current, then run
   verify_command and confirm the app still passes its own checks.
7. Draft memory/vision.md and memory/state.md from what the code and docs show today
   (what exists, what is half done, known tech debt). Mark both
   "Draft, pending owner confirmation". Ask me at most 5 short questions for what the
   code cannot tell you. Fill AGENTS.md with the directory layout, areas not to touch,
   data rules and local run commands.
8. Commit on `project-os/adopt` (including .project-os/). Do NOT push, open a PR, create
   tokens or change GitHub settings. Never commit a .env file or any secret.
9. Report briefly: what you found in step 1, files added and files merged, the
   check-project and verify results, remaining TODO(owner) items, and the steps left
   for me: review and push the branch, enable Issues, create the symphony-* and
   priority-* labels, create a fine-grained token for this repository only (Issues
   read/write, Metadata read) for Symphony, install or reinstall the worker per the
   core's docs/symphony.md, and optionally the board per docs/board.md.

Rules: never edit files under .project-os/ by hand (sync-project owns them). Write all
new files and documentation in English.
```

After the agent finishes: read its report and the diff, confirm or edit the vision
and state drafts, then push the branch and open a pull request.
