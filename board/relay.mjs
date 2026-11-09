// The board's side of the link to the Claude orchestrators. Each orchestrator
// (agent) long-polls its own inbox for the owner's commands and posts events
// back; the browser reads each feature's events and latest state from here.
// The agent's name comes from the token it called with, never from what it
// posts. "" is the unnamed agent of a board with a single AGENT_TOKEN.
//
// Everything is in memory. A board restart drops unsent commands and the live
// buffer; the Claude session and its transcript live with the orchestrator.

const maxEvents = 400;
const onlineMs = 75_000;
const statuses = new Set([
  "new",
  "running",
  "idle",
  "waiting-owner",
  "taken-over",
  "reassigned",
  "failed",
]);

// Agent names: lowercase letters, digits and dashes, used in `agent:<name>`.
export const agentName = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const agentLabelPrefix = "agent:";

const text = (value, limit) => String(value ?? "").slice(0, limit);

// Only the fields the panel shows, so the orchestrator cannot inject markup or
// arbitrary data into the page.
function cleanEvent(event, seq) {
  const base = {
    seq,
    issue: Number(event.issue),
    at: text(event.at, 40),
    kind: text(event.kind, 30),
  };
  switch (base.kind) {
    case "assistant":
    case "error":
    case "owner":
      return { ...base, text: text(event.text, 20_000) };
    case "tool":
      return {
        ...base,
        name: text(event.name, 80),
        summary: text(event.summary, 300),
      };
    case "request":
      return {
        ...base,
        id: text(event.id, 64),
        requestKind: event.requestKind === "question" ? "question" : "approval",
        tool: text(event.tool, 80),
        reason: text(event.reason, 200),
        summary: text(event.summary, 2000),
      };
    case "request-closed":
      return {
        ...base,
        id: text(event.id, 64),
        outcome: text(event.outcome, 20),
      };
    case "result":
      return {
        ...base,
        ok: Boolean(event.ok),
        costUsd: Number(event.costUsd) || 0,
      };
    case "status":
      return statuses.has(event.status)
        ? { ...base, status: event.status }
        : null;
    case "session":
    case "queued":
      return base;
    default:
      return null;
  }
}

const cleanQuestions = (questions) =>
  Array.isArray(questions)
    ? questions.slice(0, 4).map((q) => ({
        question: text(q?.question, 1000),
        header: text(q?.header, 40),
        multiSelect: Boolean(q?.multiSelect),
        options: (Array.isArray(q?.options) ? q.options : [])
          .slice(0, 6)
          .map((o) => ({
            label: text(o?.label, 200),
            description: text(o?.description, 500),
          })),
      }))
    : null;

function cleanState(state, agent) {
  const issue = Number(state?.issue);
  if (!Number.isInteger(issue) || issue <= 0) return null;
  return {
    issue,
    agent,
    host: state.host === "dokploy" ? "dokploy" : "mac",
    status: statuses.has(state.status) ? state.status : "new",
    sessionId: /^[0-9a-f-]{36}$/i.test(state.sessionId ?? "")
      ? state.sessionId
      : null,
    workspace:
      typeof state.workspace === "string" &&
      !/[\n\r'"`$\\]/.test(state.workspace)
        ? text(state.workspace, 500)
        : null,
    question: state.question ? text(state.question, 4000) : null,
    queued: Number(state.queued) || 0,
    turns: Number(state.turns) || 0,
    costUsd: Number(state.costUsd) || 0,
    updatedAt: text(state.updatedAt, 40),
    requests: (Array.isArray(state.requests) ? state.requests : [])
      .slice(0, 10)
      .map((r) => ({
        id: text(r?.id, 64),
        kind: r?.kind === "question" ? "question" : "approval",
        tool: text(r?.tool, 80),
        reason: text(r?.reason, 200),
        summary: text(r?.summary, 2000),
        questions: r?.kind === "question" ? cleanQuestions(r.questions) : null,
      })),
  };
}

export function createRelay({ now = Date.now } = {}) {
  const inboxes = new Map(); // agent -> commands
  const waiters = new Map(); // agent -> Set of wake functions
  const lastSeen = new Map(); // agent -> time of its last call
  const features = new Map();
  let seq = 0;

  const inbox = (agent) => {
    if (!inboxes.has(agent)) inboxes.set(agent, []);
    return inboxes.get(agent);
  };
  const wakers = (agent) => {
    if (!waiters.has(agent)) waiters.set(agent, new Set());
    return waiters.get(agent);
  };
  const feature = (issue) => {
    if (!features.has(issue)) features.set(issue, { events: [], state: null });
    return features.get(issue);
  };

  function record(issue, event) {
    const clean = cleanEvent({ ...event, issue }, ++seq);
    if (!clean) return;
    const { events } = feature(issue);
    events.push(clean);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  }

  // A command from the owner for one agent. Owner messages also go into the
  // feature's log.
  function push(agent, command) {
    if (command.type === "message")
      record(command.issue, {
        kind: "owner",
        text: command.text,
        at: new Date(now()).toISOString(),
      });
    inbox(agent).push(command);
    for (const wake of wakers(agent)) wake();
  }

  // An agent's long poll: returns its queued commands, or waits for one.
  function take(agent, waitMs, closed) {
    lastSeen.set(agent, now());
    const queue = inbox(agent);
    if (queue.length || waitMs <= 0) return Promise.resolve(queue.splice(0));
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        wakers(agent).delete(done);
        lastSeen.set(agent, now());
        resolve(queue.splice(0));
      };
      const timer = setTimeout(done, waitMs);
      wakers(agent).add(done);
      closed?.then(done);
    });
  }

  function receive(agent, { events = [], states = [] } = {}) {
    lastSeen.set(agent, now());
    for (const event of Array.isArray(events) ? events.slice(0, 200) : []) {
      const issue = Number(event?.issue);
      if (Number.isInteger(issue) && issue > 0) record(issue, event);
    }
    for (const raw of Array.isArray(states) ? states.slice(0, 200) : []) {
      const state = cleanState(raw, agent);
      if (!state) continue;
      const entry = feature(state.issue);
      // An agent that lost the feature does not hide the new agent's state.
      if (
        state.status === "reassigned" &&
        entry.state &&
        entry.state.agent !== agent
      )
        continue;
      entry.state = state;
    }
  }

  // One agent, or any agent when none is named.
  const online = (agent) =>
    agent === undefined
      ? [...lastSeen.values()].some((at) => now() - at < onlineMs)
      : now() - (lastSeen.get(agent) ?? 0) < onlineMs;

  // `agent` is the one the feature is assigned to, for its online status.
  function view(issue, after = 0, agent) {
    const entry = features.get(issue);
    return {
      online: online(agent ?? entry?.state?.agent),
      state: entry?.state ?? null,
      events: (entry?.events ?? []).filter((event) => event.seq > after),
      cursor: seq,
    };
  }

  // Per-feature status for the cards.
  function summary() {
    return Object.fromEntries(
      [...features.entries()]
        .filter(([, entry]) => entry.state)
        .map(([issue, entry]) => [
          issue,
          {
            status: entry.state.status,
            requests: entry.state.requests.length,
            agent: entry.state.agent,
          },
        ]),
    );
  }

  // Commands taken by a poll whose connection closed go back to the front.
  const restore = (agent, commands) => {
    inbox(agent).unshift(...commands);
  };

  return { push, take, restore, receive, view, summary, online };
}
