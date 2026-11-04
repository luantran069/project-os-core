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

## Images

A new idea and a decision note both take images: paste, drop or choose a PNG, JPEG,
GIF or WebP of up to 5 MB. The board checks the file's bytes, so an SVG or a renamed
file is refused. Each image is stored on the repository's `board-images` branch, which
has no shared history with the default branch, and its Markdown goes into the text:

    ![name](https://github.com/owner/repo/blob/board-images/images/2026-11/<id>.png?raw=true)

The board shows the image by loading it through its own login, so it works for a private
repository. On GitHub it shows for people signed in with access. An agent reads it with:

    gh api "repos/owner/repo/contents/images/2026-11/<id>.png?ref=board-images"       -H "Accept: application/vnd.github.raw" > image.png

Images stay on the branch after their issue closes. Anyone who can read the repository
can read them, so do not attach secrets or personal data the repository should not hold.

## Claude sessions

The board can show the whole conversation of an agent run, so the owner can read it in
a browser without downloading anything. The runner does two things:

1. Save the session at `sessions/<run id>.jsonl` on the repository's `board-sessions`
   branch, a branch with no shared history like `board-images`. The file is either a
   Claude Code session file (one JSON record per line) or the execution file of
   `anthropics/claude-code-action` (one JSON array). The run id is digits only.
2. Comment on the issue with a link: `https://<board domain>/#session/<run id>`.

The link opens the conversation after the board's login. Thinking and tool calls start
collapsed, and any text over 20,000 characters is cut. The card shows a link for each
such comment. The board's token needs nothing new: Contents read covers it.

A session holds whatever the agent read and printed, and the branch keeps it until
someone deletes it. Anyone who can read the repository can read it, so remove tokens
before saving and do not do this in a public repository.

## Deploying on Dokploy

1. Create a fine-grained token for the project repository only, with: Issues
   read/write, Pull requests read/write, Contents read/write (to merge and to store images), Checks
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
