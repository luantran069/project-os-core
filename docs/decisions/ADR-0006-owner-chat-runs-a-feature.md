# ADR-0006: The owner's chat can run a feature itself

- Status: accepted
- Date: 2026-11-10
- Decided by: Luan Tran (owner), in happy-clink's ADR-0010, which is the source of this
  decision; the owner asked Claude to choose the stall warning, and Claude chose 24
  hours. Drafted by Claude.

## Context

A `ready` feature runs only on a Claude orchestrator: a named one takes the features
labelled `agent:<its name>`, the unnamed one takes unlabelled features (ADR-0002), and
`assign_agent` accepts only names in `AGENT_TOKENS`. Since ADR-0003 the owner's AI
drives the board over MCP. It often writes the plan with the owner and has tools the
orchestrators lack (Claude Desktop's browser pane and iOS Simulator), yet it has to hand
the work to an agent that starts a new session from the issue. If it built the feature
anyway and changed labels by hand, the board could not show who holds the feature, and
the unnamed orchestrator could start on it too.

## Decision

- `chat` is a reserved agent name: `chat`, or `chat-<suffix>` with lowercase letters,
  digits and dashes, 31 characters in all. Every chat uses the MCP token, so the name
  needs no token; the suffix only labels which chat holds the feature. No
  `AGENT_TOKENS` entry or `AGENT_NAME` may use it.
- `assign_agent` accepts chat names. The card shows the chat, and `agent_session`,
  `message_agent`, `answer_agent` and `control_agent` answer that no orchestrator session
  exists.
- No orchestrator takes a feature whose agent is a chat, the unnamed one included. Moving
  a feature to a chat stops the orchestrator that had it, as with any reassignment. Chat
  features do not count towards `max_concurrent_agents`.
- A new MCP tool, `claim_feature(number, suffix?)`, works only on a feature in `ready`,
  so G2 still authorizes implementation. It sets the chat's `agent:` label and the
  in-progress label, leaves a signed comment and returns the rendered `WORKFLOW.md`
  prompt an agent would get. The board reads `WORKFLOW.md` from the default branch, since
  it has no checkout.
- The prompt ends with a section for the chat, chosen by the owner, because the workflow
  tells a coding agent never to merge and, with `gates.merge: ai`, to hand off to the AI
  reviewer, who never takes a chat's feature. The section overrides only those parts: no
  `ai_review` label; hand off with `human_review` so the feature is in review; once CI is
  green, review the diff with `get_pull_request` and merge with `decide approve`; block
  the feature instead if CI cannot pass. Every other step of the workflow applies.
  Orchestrator agents never get this section.
- A chat feature in `running` whose Agent Workpad has not changed for
  `runtime.chat.stale_hours` hours (default 24) gets a warning on its card and in
  `board_overview` and `get_feature`. The clock starts at the later of the workpad's last
  edit and the comment that gave the feature to the chat, so a workpad an earlier agent
  left does not count against it. The board only warns.
- Symphony reads only the ready label, so the board refuses chat names on a project with
  `runtime.orchestrator: symphony`.

## Alternatives considered

The project's ADR lists them: labels changed by hand with `gh` (nothing stops an
orchestrator), an orchestrator on the owner's Mac (a new session without the chat's
context or tools), a token per chat (every chat would need its own token and MCP
configuration), merging only after another session's review (the owner chose full
power, as in ADR-0003), and a shorter stall limit (a chat on a laptop pauses overnight,
so a few hours would warn on most chat features most days).

## Consequences

- A small feature can go from plan to pull request, and to the merge, in one session.
- A chat is not durable: closing it stops the work while the feature shows as running.
  The workpad is the only checkpoint, and the warning is how the owner notices.
- The board shows no live session, cost or questions for chat features.
- The AI reviewer of ADR-0005 runs inside an orchestrator, so it never reviews or merges
  a chat's pull request; the chat decides it, as its prompt section says, or the owner.
- The suffix is a label, not an identity: any chat with the MCP token can claim under any
  `chat-` name or take a feature over from another chat.
- The board image now also copies `orchestrator/prompt.mjs`, to render the prompt.
