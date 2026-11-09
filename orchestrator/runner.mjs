import { randomUUID } from "node:crypto";
import { decide, describe } from "./policy.mjs";

// Runs turns of each feature's Claude session. One turn at a time per feature,
// at most `maxConcurrent` features at once. Messages that arrive during a turn
// are queued and sent together as the next turn, resuming the same session.

const away = {
  question:
    "The owner is not at the board right now. Write your question(s) as your final message and end your turn; the owner's reply will resume this session.",
  approval:
    "The owner did not answer in time. Do not try another way. Say in your final message what you need approved and why, then end your turn.",
};

// The parts of an SDK message the board shows. Thinking and tool results stay
// in the session file; the panel shows what the agent said and did.
export function eventsOf(message) {
  if (message.type === "system" && message.subtype === "init")
    return [{ kind: "session", sessionId: message.session_id }];
  if (message.type === "assistant") {
    const events = [];
    for (const block of message.message?.content ?? []) {
      if (block.type === "text" && block.text.trim())
        events.push({ kind: "assistant", text: block.text });
      else if (block.type === "tool_use")
        events.push({
          kind: "tool",
          name: block.name,
          summary: describe(block.name, block.input)
            .split("\n")[0]
            .slice(0, 200),
        });
    }
    return events;
  }
  if (message.type === "result")
    return [
      {
        kind: "result",
        ok: message.subtype === "success" && !message.is_error,
        costUsd: message.total_cost_usd ?? 0,
        steps: message.num_turns ?? null,
      },
    ];
  return [];
}

export function createRunner({
  query,
  store,
  emit,
  systemAppend = "",
  maxConcurrent = 1,
  maxTurns = 200,
  approvalTimeoutMs = 30 * 60_000,
  model,
  env,
}) {
  const queues = new Map(); // issue -> [{ text, workspace }]
  const active = new Map(); // issue -> AbortController
  const pending = new Map(); // request id -> { issue, kind, input, finish }

  const publish = (issue, event) => emit(issue, event, snapshot(issue));

  function snapshot(issue) {
    const record = store.get(issue);
    return {
      ...record,
      queued: queues.get(issue)?.length ?? 0,
      requests: [...pending.entries()]
        .filter(([, p]) => p.issue === issue)
        .map(([id, p]) => ({ id, ...p.view })),
    };
  }

  function send(issue, text, { workspace } = {}) {
    const queue = queues.get(issue) ?? [];
    queue.push({ text, workspace });
    queues.set(issue, queue);
    publish(issue, { kind: "queued", count: queue.length });
    pump();
  }

  function pump() {
    for (const [issue, queue] of queues) {
      if (!queue.length || active.has(issue)) continue;
      if (active.size >= maxConcurrent) return;
      // A taken-over feature keeps its messages until the owner hands it back.
      if (store.get(issue).status === "taken-over") continue;
      const batch = queue.splice(0);
      const abort = new AbortController();
      active.set(issue, abort);
      runTurn(issue, batch, abort).finally(() => {
        active.delete(issue);
        pump();
      });
    }
  }

  function gate(issue, workspace, toolName, input, signal, onAway) {
    const verdict = decide(toolName, input, { workspace });
    if (verdict.behavior === "allow")
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    if (verdict.behavior === "deny") return Promise.resolve(verdict);
    const kind = toolName === "AskUserQuestion" ? "question" : "approval";
    const id = randomUUID();
    const view = {
      kind,
      tool: toolName,
      reason: verdict.reason,
      summary: describe(toolName, input),
      questions: kind === "question" ? (input.questions ?? []) : null,
    };
    return new Promise((resolve) => {
      let timer;
      const finish = (result, outcome) => {
        if (!pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        publish(issue, { kind: "request-closed", id, outcome });
        resolve(result);
      };
      timer = setTimeout(() => {
        onAway();
        finish({ behavior: "deny", message: away[kind] }, "timeout");
      }, approvalTimeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", () =>
        finish(
          { behavior: "deny", message: "Cancelled", interrupt: true },
          "cancelled",
        ),
      );
      pending.set(id, { issue, kind, input, view, finish });
      publish(issue, { ...view, kind: "request", requestKind: kind, id });
    });
  }

  // The owner's answer to a question or an approval, from the board.
  function answer(issue, id, { allow = true, answers = {}, note = "" } = {}) {
    const request = pending.get(id);
    if (!request || request.issue !== issue) return false;
    const why = String(note).trim();
    if (!allow)
      request.finish(
        {
          behavior: "deny",
          message: why ? `The owner said no: ${why}` : "The owner said no.",
        },
        "denied",
      );
    else if (request.kind === "question")
      request.finish(
        {
          behavior: "allow",
          updatedInput: { ...request.input, answers: { ...answers } },
        },
        "answered",
      );
    else
      request.finish(
        { behavior: "allow", updatedInput: request.input },
        "allowed",
      );
    return true;
  }

  async function runTurn(issue, batch, abort) {
    const before = store.get(issue);
    const workspace =
      batch.findLast((item) => item.workspace)?.workspace ?? before.workspace;
    if (!workspace) {
      store.update(issue, { status: "failed" });
      publish(issue, { kind: "error", text: "No workspace for this feature" });
      return;
    }
    store.update(issue, { status: "running", workspace, question: null });
    publish(issue, { kind: "status", status: "running" });
    let ownerAway = false;
    let sessionId = before.sessionId;
    let result = null;
    let failure = null;
    try {
      const stream = query({
        prompt: batch.map((item) => item.text).join("\n\n"),
        options: {
          cwd: workspace,
          ...(sessionId ? { resume: sessionId } : {}),
          permissionMode: "default",
          canUseTool: (toolName, input, { signal } = {}) =>
            gate(issue, workspace, toolName, input, signal, () => {
              ownerAway = true;
            }),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemAppend,
          },
          settingSources: ["project"],
          maxTurns,
          abortController: abort,
          ...(model ? { model } : {}),
          ...(env ? { env } : {}),
        },
      });
      for await (const message of stream) {
        if (message.session_id && message.session_id !== sessionId) {
          sessionId = message.session_id;
          store.update(issue, { sessionId });
        }
        if (message.type === "result") result = message;
        for (const event of eventsOf(message)) publish(issue, event);
      }
    } catch (error) {
      failure = abort.signal.aborted ? null : error;
    }
    const now = store.get(issue);
    if (now.status === "taken-over" || now.status === "reassigned")
      return publish(issue, { kind: "status", status: now.status });
    const ok =
      !failure && result && result.subtype === "success" && !result.is_error;
    store.update(issue, {
      status: !ok ? "failed" : ownerAway ? "waiting-owner" : "idle",
      question:
        ok && ownerAway ? String(result.result ?? "").slice(0, 4000) : null,
      turns: before.turns + 1,
      costUsd: Number(
        (before.costUsd + (result?.total_cost_usd ?? 0)).toFixed(4),
      ),
    });
    if (failure)
      // SDK errors can quote task input; keep the board message generic.
      publish(issue, {
        kind: "error",
        text: "The turn stopped with an error; see the orchestrator log.",
      });
    publish(issue, { kind: "status", status: store.get(issue).status });
  }

  // The owner continues by hand: stop the running turn, refuse what it waits on,
  // and keep later messages until release().
  function takeOver(issue) {
    for (const [id, request] of pending)
      if (request.issue === issue)
        request.finish(
          {
            behavior: "deny",
            message: "The owner took over.",
            interrupt: true,
          },
          "cancelled",
        );
    active.get(issue)?.abort();
    store.update(issue, { status: "taken-over" });
    publish(issue, { kind: "status", status: "taken-over" });
  }

  // The feature went to another agent: stop here for good. The session stays
  // on this machine for reference; if the feature comes back, it starts anew.
  function detach(issue) {
    const record = store.get(issue);
    if (record.status === "reassigned" && !busy(issue)) return;
    for (const [, request] of pending)
      if (request.issue === issue)
        request.finish(
          {
            behavior: "deny",
            message: "The feature was given to another agent.",
            interrupt: true,
          },
          "cancelled",
        );
    queues.delete(issue);
    active.get(issue)?.abort();
    store.update(issue, {
      status: "reassigned",
      sessionId: null,
      dispatchedReady: false,
      previousSessions: [
        ...(record.previousSessions ?? []),
        ...(record.sessionId ? [record.sessionId] : []),
      ],
    });
    publish(issue, { kind: "status", status: "reassigned" });
  }

  function release(issue) {
    if (store.get(issue).status !== "taken-over") return;
    store.update(issue, { status: "idle" });
    publish(issue, { kind: "status", status: "idle" });
    pump();
  }

  function stopAll() {
    for (const abort of active.values()) abort.abort();
  }

  const busy = (issue) =>
    active.has(issue) || (queues.get(issue)?.length ?? 0) > 0;

  return {
    send,
    answer,
    takeOver,
    detach,
    release,
    snapshot,
    stopAll,
    busy,
  };
}
