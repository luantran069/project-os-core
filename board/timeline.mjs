// The Timeline tab's rows, from GitHub milestones and their issues (ADR-0007).
// Dates stay ISO strings; the page turns them into positions.
import { loadMilestones, stageOf } from "./github.mjs";

const earliest = (dates) =>
  dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
const latest = (dates) =>
  dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
const byStart = (a, b) =>
  Date.parse(a.start) - Date.parse(b.start) || a.number - b.number;

function featureBar(issue, labels, today) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    stage: stageOf(issue, labels),
    start: issue.created_at,
    end: issue.closed_at ?? today,
  };
}

// milestones: GitHub milestones (open and closed). issues: every issue in a
// milestone plus the open ones without one. today: an ISO date.
export function buildTimeline({ milestones, issues, labels, today }) {
  const features = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      milestone: issue.milestone?.number ?? null,
      bar: featureBar(issue, labels, today),
    }));
  const groups = milestones
    .map((milestone) => {
      const bars = features
        .filter((f) => f.milestone === milestone.number)
        .map((f) => f.bar)
        .sort(byStart);
      const open = milestone.open_issues ?? 0;
      const closed = milestone.closed_issues ?? 0;
      const due = milestone.due_on ?? null;
      const isOpen = milestone.state !== "closed";
      return {
        number: milestone.number,
        title: milestone.title,
        url: milestone.html_url,
        state: milestone.state,
        due,
        start: bars.length
          ? earliest(bars.map((b) => b.start))
          : milestone.created_at,
        end: due ?? (isOpen ? today : (milestone.closed_at ?? today)),
        openEnded: !due && isOpen,
        overdue:
          Boolean(due) &&
          isOpen &&
          open > 0 &&
          Date.parse(due) < Date.parse(today),
        open,
        closed,
        progress: open + closed ? closed / (open + closed) : 0,
        features: bars,
      };
    })
    .sort(
      (a, b) =>
        (a.due ? Date.parse(a.due) : Infinity) -
          (b.due ? Date.parse(b.due) : Infinity) ||
        a.title.localeCompare(b.title),
    );
  const ungrouped = features
    .filter((f) => f.milestone === null)
    .map((f) => f.bar)
    .sort(byStart);
  const starts = [
    today,
    ...groups.map((g) => g.start),
    ...ungrouped.map((f) => f.start),
  ];
  const ends = [
    today,
    ...groups.flatMap((g) => [g.end, ...g.features.map((f) => f.end)]),
    ...ungrouped.map((f) => f.end),
  ];
  return {
    today,
    start: earliest(starts),
    end: latest(ends),
    groups,
    ungrouped,
  };
}

// Every issue in a milestone, closed ones included (the board keeps only the
// latest closed features), and the open issues without a milestone.
export async function loadTimeline(gh, labels, now = Date.now) {
  const [milestones, grouped, ungrouped] = await Promise.all([
    loadMilestones(gh),
    gh.pages(`${gh.base}/issues?state=all&milestone=*`),
    gh.pages(`${gh.base}/issues?state=open&milestone=none`),
  ]);
  return buildTimeline({
    milestones,
    issues: [...grouped, ...ungrouped],
    labels,
    today: new Date(now()).toISOString(),
  });
}
