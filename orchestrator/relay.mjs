// The orchestrator's link to the board. It only ever calls out: it long-polls
// the board for the owner's commands and posts events back, so the host (the
// owner's Mac or a Dokploy app) needs no open port.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRelay({
  boardUrl,
  token,
  agent = "",
  fetchImpl = fetch,
  log = console.error,
}) {
  const base = new URL(boardUrl);
  const outbox = [];
  const states = new Map();
  let flushing = null;
  let stopped = false;

  async function call(path, { method = "GET", body, timeoutMs = 20_000 } = {}) {
    const response = await fetchImpl(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "project-os-orchestrator",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = new Error(
        `Board ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  // Queue an event for the board, with the feature's latest state.
  function emit(issue, event, state) {
    outbox.push({ issue, at: new Date().toISOString(), ...event });
    if (state) states.set(issue, state);
    flushing ??= flush().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function flush() {
    while ((outbox.length || states.size) && !stopped) {
      const events = outbox.splice(0, 100);
      const snapshot = [...states.values()];
      states.clear();
      try {
        await call("/api/agent/events", {
          method: "POST",
          body: { events, states: snapshot },
        });
      } catch (error) {
        outbox.unshift(...events);
        for (const state of snapshot)
          if (!states.has(state.issue)) states.set(state.issue, state);
        log(`Orchestrator could not reach the board: ${error.message}`);
        await sleep(3000);
      }
    }
  }

  // Calls onCommand for each command the owner sends, until stop().
  async function listen(onCommand, { waitSeconds = 25 } = {}) {
    while (!stopped) {
      try {
        const { agent: seen, commands = [] } = await call(
          `/api/agent/inbox?wait=${waitSeconds}`,
          {
            timeoutMs: (waitSeconds + 10) * 1000,
          },
        );
        // The board names the agent by its token. A mismatch means this
        // machine holds another agent's token: stop rather than act for it.
        if (seen !== undefined && seen !== agent) {
          stopped = true;
          for (const command of commands)
            log(`Ignored ${command?.type} for #${command?.issue}`);
          throw Object.assign(
            new Error(
              `AGENT_NAME is "${agent}" but the board knows this token as "${seen}". Fix AGENT_NAME or the token.`,
            ),
            { fatal: true },
          );
        }
        for (const command of commands) {
          try {
            await onCommand(command);
          } catch (error) {
            log(
              `Orchestrator could not handle a ${command?.type} command: ${error.message}`,
            );
          }
        }
      } catch (error) {
        if (error.fatal) throw error;
        if (stopped) break;
        log(`Orchestrator could not poll the board: ${error.message}`);
        await sleep(error.status === 401 ? 30_000 : 3000);
      }
    }
  }

  const stop = () => {
    stopped = true;
  };

  return { emit, flush: () => flushing ?? Promise.resolve(), listen, stop };
}
