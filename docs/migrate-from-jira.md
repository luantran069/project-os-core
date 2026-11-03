# Moving a project from Jira to GitHub Issues

Do this once for each project that still uses Jira (for example good-ideas with
the IS project). Run it on the worker host, where the Jira credentials already are.

1. Sync the project to core 0.3.0 and add `labels.in_progress: symphony-in-progress`
   to `project.yaml`. Keep `tracker.kind: jira` until step 4.
2. Dry run, nothing is written:

   ```bash
   JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... GITHUB_TOKEN=... \
     npm run symphony:migrate-jira -- --jira-project IS
   ```

   The command prints which issue each ticket becomes, with which labels and
   dependencies. Tickets already Done are only written to `docs/jira-archive.md`,
   not turned into issues.

3. Read the list. If it is right, run again with `--apply`. The command creates
   missing labels, creates the issues (with the Jira comments, Roadmap priority as
   `priority-now/next/later`, and "Blocks" links as a **Dependencies** line in the
   description) and writes the archive file. Running it again creates no
   duplicates: an issue that already carries `<!-- jira:IS-12 -->` is skipped.
4. Stop the Symphony service. Change `project.yaml` to
   `tracker: { kind: github, repo: ... }` and `WORKFLOW.md` to follow
   `template/WORKFLOW.md`. Reinstall the service with a source file that holds only
   `GITHUB_TOKEN` (see [Symphony in the core](symphony.md#github-issues)), run
   `npm run symphony:check -- --live`, then start the service.
5. Deploy the board per [Project board](board.md) and run one small feature end to
   end. Close the Jira project only after that works.

The GitHub token for steps 2 and 3 needs Issues read/write on the project repository.
