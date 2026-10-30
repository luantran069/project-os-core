import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readProject } from "./project.mjs";

// One-time move of a Jira project's open tickets into GitHub issues, so the
// project can switch to tracker.kind: github. Dry run unless --apply. Done
// tickets go to an archive file instead of becoming issues. Re-running skips
// tickets that already have an issue (found by the jira marker in the body).

const marker = (key) => `<!-- jira:${key} -->`;
const markerPattern = /<!-- jira:([A-Z][A-Z0-9]*-\d+) -->/;
const palette = {
  idea: "c5def5",
  plan: "bfd4f2",
  ready: "0e8a16",
  in_progress: "1d76db",
  blocked: "b60205",
  human_review: "fbca04",
  pilot_review: "fef2c0",
};

// Atlassian Document Format to Markdown, for the node types Jira descriptions
// and comments use. Unknown nodes keep their text.
export function adfToMarkdown(node, depth = 0) {
  if (!node) return "";
  if (typeof node === "string") return node;
  const inner = (sep = "") =>
    (node.content ?? []).map((child) => adfToMarkdown(child, depth)).join(sep);
  switch (node.type) {
    case "doc":
      return (node.content ?? [])
        .map((child) => adfToMarkdown(child, depth))
        .filter((text) => text.trim())
        .join("\n\n")
        .trim();
    case "paragraph":
      return inner();
    case "text": {
      let text = node.text ?? "";
      for (const mark of node.marks ?? []) {
        if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "em") text = `_${text}_`;
        else if (mark.type === "link" && mark.attrs?.href)
          text = `[${text}](${mark.attrs.href})`;
      }
      return text;
    }
    case "hardBreak":
      return "\n";
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 2)} ${inner()}`;
    case "bulletList":
    case "orderedList":
    case "taskList":
      return (node.content ?? [])
        .map((item, index) => {
          const prefix =
            node.type === "orderedList"
              ? `${index + 1}.`
              : node.type === "taskList"
                ? `- [${item.attrs?.state === "DONE" ? "x" : " "}]`
                : "-";
          const body = (item.content ?? [])
            .map((child) => adfToMarkdown(child, depth + 1))
            .join("\n");
          return `${"  ".repeat(depth)}${prefix} ${body.trimStart()}`;
        })
        .join("\n");
    case "taskItem":
    case "listItem":
      return inner("\n");
    case "codeBlock":
      return `\`\`\`${node.attrs?.language ?? ""}\n${inner()}\n\`\`\``;
    case "blockquote":
      return inner("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url ?? "";
    case "mention":
      return node.attrs?.text ?? "";
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "table":
      return (node.content ?? [])
        .map((row, index) => {
          const cells = (row.content ?? []).map((cell) =>
            adfToMarkdown({
              type: "paragraph",
              content: cell.content?.flatMap((p) => p.content ?? []),
            }).replaceAll("|", "\\|"),
          );
          const line = `| ${cells.join(" | ")} |`;
          return index === 0
            ? `${line}\n| ${cells.map(() => "---").join(" | ")} |`
            : line;
        })
        .join("\n");
    default:
      return inner();
  }
}

const lower = (value) => String(value ?? "").toLowerCase();

// Board labels for a ticket, from its Jira status and labels.
export function stageLabels(status, jiraLabels, labels) {
  const has = (key) =>
    labels[key] && jiraLabels.some((l) => lower(l) === lower(labels[key]));
  const name = lower(status);
  if (has("blocked")) return [labels.blocked];
  if (name === "impact")
    return [
      labels.human_review,
      has("pilot_review") && labels.pilot_review,
    ].filter(Boolean);
  if (name === "delivery" && has("ready"))
    return [labels.ready, labels.in_progress];
  if (has("ready")) return [labels.ready];
  if (name === "discovery" || has("plan")) return [labels.plan];
  return [labels.idea];
}

export function priorityLabel(value) {
  const text = lower(value?.value ?? value?.name ?? value);
  for (const name of ["now", "next", "later"])
    if (text === name) return `priority-${name}`;
  return null;
}

// Labels we set from the stage; every other Jira label carries over as a topic.
const stageNames = (labels) => new Set(Object.values(labels).map(lower));

export function issueFor(ticket, { labels, jiraBase, roadmapField }) {
  const fields = ticket.fields ?? {};
  const jiraLabels = fields.labels ?? [];
  const topics = jiraLabels.filter((l) => !stageNames(labels).has(lower(l)));
  const priority = roadmapField ? priorityLabel(fields[roadmapField]) : null;
  const description = adfToMarkdown(fields.description);
  return {
    key: ticket.key,
    title: fields.summary ?? ticket.key,
    labels: [
      ...stageLabels(fields.status?.name, jiraLabels, labels),
      ...(priority ? [priority] : []),
      ...topics,
    ],
    body: [
      marker(ticket.key),
      `Chuyển từ Jira [${ticket.key}](${jiraBase}/browse/${ticket.key}) (trạng thái ${fields.status?.name ?? "?"}).`,
      "",
      description || "_Không có mô tả._",
    ].join("\n"),
    blockedBy: (fields.issuelinks ?? [])
      .filter((link) => lower(link.type?.name) === "blocks" && link.inwardIssue)
      .map((link) => link.inwardIssue.key),
  };
}

export function archiveMarkdown(project, tickets, jiraBase, date) {
  const rows = tickets.map(
    (t) =>
      `| [${t.key}](${jiraBase}/browse/${t.key}) | ${String(t.fields?.summary ?? "").replaceAll("|", "\\|")} | ${t.fields?.status?.name ?? ""} |`,
  );
  return `# Jira archive: ${project}

Tickets that were already done when the project moved from Jira to GitHub Issues
on ${date}. They were not copied as issues.

| Ticket | Title | Status |
| ------ | ----- | ------ |
${rows.join("\n")}
`;
}

function client(base, headers, fetchImpl, name) {
  return async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...headers,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(
        `${name} ${method} ${path.split("?")[0]} could not connect`,
      );
    }
    if (!response.ok)
      throw new Error(
        `${name} ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`,
      );
    return response.status === 204 ? null : response.json();
  };
}

export async function migrate({
  root = process.cwd(),
  jiraProject,
  repo,
  apply = false,
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  date = new Date().toISOString().slice(0, 10),
}) {
  const manifest = await readProject(root);
  const labels = manifest.labels ?? {};
  for (const key of [
    "JIRA_BASE_URL",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "GITHUB_TOKEN",
  ])
    if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
  if (!labels.in_progress)
    throw new Error("Add labels.in_progress to project.yaml first");
  const jiraBase = env.JIRA_BASE_URL.trim().replace(/\/$/, "");
  const jira = client(
    jiraBase,
    {
      Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL.trim()}:${env.JIRA_API_TOKEN.trim()}`).toString("base64")}`,
    },
    fetchImpl,
    "Jira",
  );
  const github = client(
    `https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`,
    {
      Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "project-os-migrate-jira",
    },
    fetchImpl,
    "GitHub",
  );

  const fields = await jira("/rest/api/3/field");
  const roadmapField =
    fields.find((f) => lower(f.name) === "roadmap")?.id ?? null;
  const tickets = [];
  let nextPageToken;
  do {
    const page = await jira("/rest/api/3/search/jql", {
      method: "POST",
      body: {
        jql: `project = "${jiraProject}" ORDER BY key ASC`,
        fields: [
          "summary",
          "description",
          "status",
          "labels",
          "issuelinks",
          "comment",
          ...(roadmapField ? [roadmapField] : []),
        ],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    tickets.push(...(page.issues ?? []));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);
  tickets.sort(
    (a, b) => Number(a.key.split("-")[1]) - Number(b.key.split("-")[1]),
  );

  const done = tickets.filter(
    (t) => t.fields?.status?.statusCategory?.key === "done",
  );
  const open = tickets.filter((t) => !done.includes(t));
  const existing = new Map();
  for (let page = 1; ; page++) {
    const batch = await github(`/issues?state=all&per_page=100&page=${page}`);
    for (const issue of batch) {
      const key = String(issue.body ?? "").match(markerPattern)?.[1];
      if (key) existing.set(key, issue.number);
    }
    if (batch.length < 100) break;
  }
  const planned = open.map((t) =>
    issueFor(t, { labels, jiraBase, roadmapField }),
  );
  const todo = planned.filter((p) => !existing.has(p.key));

  log(
    `Jira ${jiraProject}: ${tickets.length} tickets, ${done.length} done (archive), ${open.length} open.`,
  );
  for (const p of planned)
    log(
      `${existing.has(p.key) ? "skip  " : "create"} ${p.key} → [${p.labels.join(", ")}] ${p.title}${p.blockedBy.length ? ` (blocked by ${p.blockedBy.join(", ")})` : ""}`,
    );
  if (!apply) {
    log("Dry run: nothing was written. Re-run with --apply.");
    return { planned, created: [], archived: done.length };
  }

  const repoLabels = new Set();
  for (let page = 1; ; page++) {
    const batch = await github(`/labels?per_page=100&page=${page}`);
    for (const l of batch) repoLabels.add(lower(l.name));
    if (batch.length < 100) break;
  }
  const colors = Object.fromEntries(
    Object.entries(labels).map(([k, v]) => [lower(v), palette[k]]),
  );
  const wanted = new Set([
    ...Object.values(labels),
    ...planned.flatMap((p) => p.labels),
  ]);
  for (const name of wanted)
    if (name && !repoLabels.has(lower(name))) {
      await github("/labels", {
        method: "POST",
        body: { name, color: colors[lower(name)] ?? "ededed" },
      });
      repoLabels.add(lower(name));
      log(`label  ${name}`);
    }

  const created = [];
  for (const p of todo) {
    const issue = await github("/issues", {
      method: "POST",
      body: { title: p.title, body: p.body, labels: p.labels },
    });
    existing.set(p.key, issue.number);
    created.push({ key: p.key, number: issue.number });
    const ticket = open.find((t) => t.key === p.key);
    for (const comment of ticket.fields?.comment?.comments ?? [])
      await github(`/issues/${issue.number}/comments`, {
        method: "POST",
        body: {
          body: `_Bình luận Jira của ${comment.author?.displayName ?? "?"}, ${comment.created ?? ""}_\n\n${adfToMarkdown(comment.body)}`,
        },
      });
    log(`#${issue.number} ← ${p.key}`);
  }
  for (const p of planned.filter(
    (p) => p.blockedBy.length && created.some((c) => c.key === p.key),
  )) {
    const refs = p.blockedBy.map((key) =>
      existing.has(key) ? `#${existing.get(key)}` : `${key} (Jira, đã xong)`,
    );
    await github(`/issues/${existing.get(p.key)}`, {
      method: "PATCH",
      body: {
        body: `${p.body}\n\n**Phụ thuộc:** cần xong ${refs.join(", ")} trước.`,
      },
    });
  }
  const archive = join(root, "docs/jira-archive.md");
  await writeFile(archive, archiveMarkdown(jiraProject, done, jiraBase, date));
  log(`Wrote ${archive}. Created ${created.length} issues.`);
  return { planned, created, archived: done.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "jira-project": { type: "string" },
      repo: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  try {
    const root = resolve(".");
    const manifest = await readProject(root);
    const repo =
      values.repo ?? manifest.tracker?.repo ?? manifest.project?.repository;
    if (!values["jira-project"] || !repo)
      throw new Error(
        "Usage: node migrate-jira.mjs --jira-project IS [--repo owner/name] [--apply]",
      );
    await migrate({
      root,
      jiraProject: values["jira-project"],
      repo,
      apply: values.apply,
    });
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
