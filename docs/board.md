# Project board

The board is a web page per project where the owner follows each feature and
approves it at the gates. Its data lives in the GitHub Issues of the project
repository (`tracker.kind: github`), so Symphony and the board read the same
source; the board has no database of its own. The code lives in
[`board/`](../board/) of the core and `sync-project` copies it into the project's
`.project-os/board/`.

## What the board shows

| Column    | Open issues with label             | Buttons                                         |
| --------- | ---------------------------------- | ----------------------------------------------- |
| Idea      | `idea` (or no stage label yet)     | Approve G1 → Plan, Request changes, Stop        |
| Plan      | `plan`                             | Approve G2 → add `ready`, Request changes, Stop |
| Ready     | `ready`                            | Pause                                           |
| Running   | `ready` + `in_progress`            | Pause agent                                     |
| In review | `human_review` or `pilot_review`   | Approve and merge PR, Request changes, Stop     |
| Blocked   | `blocked`                          | Unblock, Unblock with note, Stop                |
| Done      | closed issues (the 20 most recent) | —                                               |

Each card shows its priority (labels `priority-now`, `priority-next`,
`priority-later`), the gate it waits on, the linked PR (a PR with `Closes #N` in
its description), CI status and a preview link. The preview comes from a
`Preview: https://...` line in the PR description, or from GitHub Deployments of
the PR head commit.

Every button leaves a comment on the issue with the owner's decision and note.
"Request changes" requires a note. "Approve and merge PR" squash-merges exactly
the commit on screen; if the agent has just pushed a new commit, GitHub rejects
the merge and the board shows the error. "Stop" on Idea, Plan, In review and
Blocked closes the issue (the work is dropped).

## Deploying on Dokploy

1. Create a fine-grained token for the project repository only, with: Issues
   read/write, Pull requests read/write, Contents read/write (to merge), Checks
   read, Deployments read, Metadata read. This token belongs to the board and is
   separate from Symphony's token.
2. In Dokploy, create an Application from the project repository, build type
   Dockerfile, path `.project-os/board/Dockerfile`, build context the repository
   root.
3. Environment variables:
   - `GITHUB_TOKEN`: the token from step 1.
   - `BOARD_PASSWORD`: login password, at least 12 characters.
   - `BOARD_SESSION_SECRET`: a long random string; keeps sessions valid across
     restarts. Without it you must log in again after every deploy.
4. Attach a domain with HTTPS, port 8080. The session cookie is sent over HTTPS only.
5. Open the domain and log in. The board refreshes every minute; the ↻ button
   reloads at once.

Five wrong passwords lock the login for 5 minutes. A session lasts 30 days.

Try it locally:
`BOARD_PASSWORD=... GITHUB_TOKEN=... BOARD_INSECURE_COOKIE=1 PORT=8080 node .project-os/board/server.mjs`
from the project root, then open `http://localhost:8080`.

The board's interface text is currently in Vietnamese; the column names above are
their English equivalents.
