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

## Chat with the feature's Claude session

With `AGENT_TOKEN` set (at least 32 characters, the same value as the
[Claude orchestrator](orchestrator.md)'s), every card has a "Phiên Claude" panel. It
shows the session live, takes the owner's messages, shows the agent's questions and the
commands waiting for approval, and gives the command to continue the session in a
terminal. Cards show the session's status. The orchestrator reaches the board on
`/api/agent/inbox` and `/api/agent/events` with that token as a bearer token; the owner's
cookie never works there and the token never works on the owner's routes. Without
`AGENT_TOKEN` those routes return 404 and the board works as before.

## Several agents

To let more than one orchestrator work on the same board (the owner's Mac, a friend's
Mac, Dokploy), give each its own name and token:

```text
AGENT_TOKENS=luan-mac=<32+ characters>,friend-mac=<32+ characters>
```

Names use `a-z`, `0-9` and dashes. Each orchestrator sets the matching `AGENT_NAME` and
`AGENT_TOKEN`. The board knows who is calling from the token alone, so one agent cannot
read or answer for another, and one token can be revoked without touching the rest.

The owner picks the agent in the "Phiên Claude" panel. The board then sets the issue's
`agent:<name>` label (removing any other `agent:` label) and comments on the issue.
Only that agent starts the feature when it gets `ready`, and chat, answers and
take-over go to it alone. A feature without an `agent:` label waits: the card shows
"Chưa giao agent" and no message can be sent until it has one.

Moving a feature to another agent stops the old one at once. Its Claude session stays on
its machine; the new agent starts a new session and reads the issue and its Agent
Workpad to pick up the work. The panel asks before moving a feature that has a session.

`AGENT_TOKEN` can stay alongside `AGENT_TOKENS`. Its agent has no name and takes the
features with no `agent:` label, as before 0.7.0.

## The board as an MCP server

With `BOARD_MCP_TOKEN` set, the board also answers the Model Context Protocol at
`https://<board domain>/mcp`, so the owner's AI can do everything the owner does on the
page. Without it `/mcp` returns 404.

```text
BOARD_MCP_TOKEN=<32+ random characters, not any agent's token>
```

Add it to Claude Code (once per machine; `--scope user` makes it available in every
project):

```bash
claude mcp add --transport http --scope user board https://<board domain>/mcp \
  --header "Authorization: Bearer <BOARD_MCP_TOKEN>"
```

| Tool                  | What it does                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `board_overview`      | Features by column with priority, agent, session status, pending requests, PR checks, preview    |
| `get_feature`         | One feature: body, labels, stage, the decisions its column allows, comments, PR, session state   |
| `create_idea`         | A new issue in Idea, with an optional priority                                                   |
| `update_feature`      | Rewrite the title or body (write the plan), set or clear the priority                            |
| `comment_feature`     | Comment on the issue                                                                             |
| `decide`              | The board's buttons: `approve`, `revise` (needs a note), `stop`, with the same effect per column |
| `get_pull_request`    | A PR's description, check runs, changed files and diff, in 60,000-character windows              |
| `review_pull_request` | A GitHub review (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) at the PR's head                       |
| `assign_agent`        | Give the feature to a named agent                                                                |
| `agent_session`       | The session's status, pending questions and approvals, workspace, session id and new events      |
| `message_agent`       | Send the session a message                                                                       |
| `answer_agent`        | Allow or refuse an approval, or answer a question                                                |
| `control_agent`       | `takeover` or `release` the session                                                              |

The token carries the owner's full power on the board: `decide` with `approve` on a
feature in review squash-merges its pull request, and `stop` closes features. The board
does not ask again; the MCP client's own permission prompt is the only check, so keep
`decide` and `assign_agent` out of auto-approved tools unless the AI is meant to pass the
gates alone. Every decision leaves the usual issue comment, naming
"AI của chủ dự án, qua MCP" instead of the owner. GitHub refuses `APPROVE` and
`REQUEST_CHANGES` reviews from the account that opened the pull request; the AI can
leave a `COMMENT` review or `decide revise` instead.

The endpoint is stateless Streamable HTTP: one JSON-RPC request per POST, answered with
JSON. The token is accepted only there, the owner's cookie and the agents' tokens are not,
and a request with an `Origin` header (a browser page) is refused. Rotate the token by
changing the variable and redeploying.

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
   - `BOARD_MCP_TOKEN` (optional): turns on `/mcp` for the owner's AI, see above.
4. Attach a domain with HTTPS, port 8080. The session cookie is sent over HTTPS only.
5. Open the domain and log in. The board refreshes every minute; the ↻ button
   reloads at once.

Five wrong passwords lock the login for 5 minutes. A session lasts 30 days.

Try it locally:
`BOARD_PASSWORD=... GITHUB_TOKEN=... BOARD_INSECURE_COOKIE=1 PORT=8080 node .project-os/board/server.mjs`
from the project root, then open `http://localhost:8080`.

The board's interface text is currently in Vietnamese; the column names above are
their English equivalents.
