import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline } from "../board/timeline.mjs";
import { labels } from "./board-fake.mjs";

const today = "2026-11-16T00:00:00Z";
const label = (name) => ({ name });
const milestone = (fields) => ({
  state: "open",
  description: "",
  created_at: "2026-10-01T00:00:00Z",
  closed_at: null,
  due_on: null,
  open_issues: 0,
  closed_issues: 0,
  html_url: `https://github.com/example/demo-app/milestone/${fields.number}`,
  ...fields,
});
const issue = (fields) => ({
  state: "open",
  labels: [],
  closed_at: null,
  milestone: null,
  html_url: `https://github.com/example/demo-app/issues/${fields.number}`,
  ...fields,
});

test("a milestone runs from its first feature to its due date, filled by its closed share", () => {
  const timeline = buildTimeline({
    labels,
    today,
    milestones: [
      milestone({
        number: 1,
        title: "Onboarding",
        due_on: "2026-12-01T08:00:00Z",
        open_issues: 1,
        closed_issues: 3,
      }),
    ],
    issues: [
      issue({
        number: 10,
        title: "Đăng ký",
        state: "closed",
        created_at: "2026-10-20T00:00:00Z",
        closed_at: "2026-11-02T00:00:00Z",
        milestone: { number: 1 },
      }),
      issue({
        number: 11,
        title: "Màn chào",
        created_at: "2026-10-05T00:00:00Z",
        labels: [label(labels.ready), label(labels.in_progress)],
        milestone: { number: 1 },
      }),
    ],
  });
  const [group] = timeline.groups;
  assert.deepEqual(
    {
      ...group,
      features: group.features.map((f) => [f.number, f.start, f.end, f.stage]),
    },
    {
      number: 1,
      title: "Onboarding",
      url: "https://github.com/example/demo-app/milestone/1",
      state: "open",
      due: "2026-12-01T08:00:00Z",
      start: "2026-10-05T00:00:00Z",
      end: "2026-12-01T08:00:00Z",
      openEnded: false,
      overdue: false,
      open: 1,
      closed: 3,
      progress: 0.75,
      features: [
        [11, "2026-10-05T00:00:00Z", today, "running"],
        [10, "2026-10-20T00:00:00Z", "2026-11-02T00:00:00Z", "done"],
      ],
    },
  );
  assert.equal(timeline.today, today);
  assert.equal(timeline.start, "2026-10-05T00:00:00Z");
  assert.equal(timeline.end, "2026-12-01T08:00:00Z");
});

test("milestones without a due date run to today, past due ones with open work are overdue", () => {
  const timeline = buildTimeline({
    labels,
    today,
    milestones: [
      milestone({ number: 3, title: "Không hạn", open_issues: 1 }),
      milestone({
        number: 2,
        title: "Trễ",
        due_on: "2026-11-01T00:00:00Z",
        open_issues: 2,
      }),
      milestone({
        number: 4,
        title: "Xong đúng hạn",
        state: "closed",
        due_on: "2026-10-15T00:00:00Z",
        closed_at: "2026-10-14T00:00:00Z",
        closed_issues: 1,
      }),
    ],
    issues: [],
  });
  assert.deepEqual(
    timeline.groups.map((g) => [
      g.title,
      g.start,
      g.end,
      g.openEnded,
      g.overdue,
      g.progress,
    ]),
    [
      [
        "Xong đúng hạn",
        "2026-10-01T00:00:00Z",
        "2026-10-15T00:00:00Z",
        false,
        false,
        1,
      ],
      ["Trễ", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", false, true, 0],
      ["Không hạn", "2026-10-01T00:00:00Z", today, true, false, 0],
    ],
  );
  // The axis always reaches today.
  assert.equal(timeline.end, today);
});

test("a closed milestone without a due date ends when it closed", () => {
  const { groups } = buildTimeline({
    labels,
    today,
    milestones: [
      milestone({
        number: 5,
        title: "Cũ",
        state: "closed",
        closed_at: "2026-10-10T00:00:00Z",
      }),
    ],
    issues: [],
  });
  assert.equal(groups[0].end, "2026-10-10T00:00:00Z");
  assert.equal(groups[0].openEnded, false);
});

test("features without a milestone get their own group, and pull requests are left out", () => {
  const timeline = buildTimeline({
    labels,
    today,
    milestones: [],
    issues: [
      issue({
        number: 20,
        title: "Ý tưởng lẻ",
        created_at: "2026-11-10T00:00:00Z",
        labels: [label(labels.idea)],
      }),
      issue({
        number: 21,
        title: "PR",
        created_at: "2026-11-11T00:00:00Z",
        pull_request: {},
      }),
    ],
  });
  assert.deepEqual(timeline.groups, []);
  assert.deepEqual(
    timeline.ungrouped.map((f) => [f.number, f.stage, f.end]),
    [[20, "idea", today]],
  );
  assert.equal(timeline.start, "2026-11-10T00:00:00Z");
});

test("an empty project has a timeline of today alone", () => {
  assert.deepEqual(
    buildTimeline({ labels, today, milestones: [], issues: [] }),
    {
      today,
      start: today,
      end: today,
      groups: [],
      ungrouped: [],
    },
  );
});
