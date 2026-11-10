# ADR-0004: The board holds token fingerprints, machines hold the tokens

- Status: accepted
- Date: 2026-11-10
- Decided by: Luan Tran (owner), who asked that a personal machine's token not be kept
  on the server; drafted by Claude

## Context

Every orchestrator and every AI that drives the board proves who it is with a bearer
token, and until 0.8.0 the board's environment held each token in full. For a friend's
or another personal machine, that means whoever administers Dokploy, or reads the
board's settings, can act as that machine. The owner wants each token kept on the machine
that uses it, with the board keeping one shared place for all of them, as now.

## Decision

- A stored token may be its fingerprint, `sha256:` and the hex SHA-256 of the token. The
  board hashes the bearer token of each call and compares fingerprints in constant
  time. Plain tokens still work.
- The shared place stays the board's environment: `AGENT_TOKENS` and the new
  `BOARD_MCP_TOKENS`, both `name=value` lists. Naming MCP tokens lets each machine's AI
  be revoked alone and named in its decision comments.
- `board/token.mjs` makes a token where it will be used (`.env` for an orchestrator,
  Claude Code's settings for an AI) and prints only the fingerprint line.
- A plain SHA-256 is enough: the tokens are 32 random bytes, so a fingerprint cannot be
  guessed back, and a slow password hash would add nothing.

## Alternatives considered

- **Keep tokens in the browser that opens the board.** The orchestrator and Claude Code
  use the tokens, not the browser, and they cannot read its storage; a token in
  `localStorage` would also be open to any script injected into the page.
- **Register machines on the board and store them itself.** The board has no database;
  it would need a volume or a write to GitHub, where anyone who reads the repository
  sees them.
- **Sign requests with a key pair per machine.** Stronger, but every client would need
  custom signing, and Claude Code only sends a fixed header.

## Consequences

- Reading the board's settings no longer lets anyone act as a machine. Taking the
  machine still does: the token is there.
- A lost token cannot be read back from the board. The machine makes a new one and the
  owner replaces its line.
- `GITHUB_TOKEN` stays in full on the board, which needs it to call GitHub.
