# ADR-0003: The board as an MCP server for the owner's AI

- Status: accepted
- Date: 2026-11-10
- Decided by: Luan Tran (owner), who chose full power for the AI, merging included, and
  Claude Code as the client; drafted by Claude

## Context

The owner wants their own AI to run the board for them: take an idea, plan it, pass the
gates, review the agent's pull request, manage the features and talk to the agents'
Claude sessions. The board already does all of this behind the owner's login, and the
link to the agents (the relay) lives only in the board's memory.

## Decision

- The board serves MCP at `/mcp`, Streamable HTTP, stateless JSON answers. It runs in
  the board process so it reaches the relay, and needs no new dependency.
- One bearer token, `BOARD_MCP_TOKEN`, turns it on. It is separate from the owner's
  cookie and from every agent token, and works nowhere else. Requests with an `Origin`
  header are refused, so a web page cannot drive the endpoint from a browser.
- The tools call the same functions as the board's buttons, so every column allows the
  same decisions and each one leaves the same audit comment, naming the AI.
- The token can do everything the owner can, including squash-merging. The MCP client's
  permission prompt is the owner's remaining check.

## Alternatives considered

- **A local stdio server calling the board's HTTP API.** It would need its own login to
  the owner routes and a process on every machine; the HTTP endpoint is one URL.
- **An MCP server that talks to GitHub directly.** It could not reach the relay, so no
  chat with agents.
- **Refuse merging through MCP.** Safer, but the owner chose full power.
- **OAuth, for claude.ai connectors.** Not needed for Claude Code; can come later.

## Consequences

- Whoever holds the token can merge and close features: keep it like a password.
- A project whose gates are `required` has the owner's AI pass them once the token is
  set; the project records that choice in its own ADR.
- claude.ai and the Claude app cannot add the board until it supports OAuth.
