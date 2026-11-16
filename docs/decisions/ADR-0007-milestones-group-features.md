# ADR-0007: Milestones group features, and the board draws them on a timeline

- Status: accepted
- Date: 2026-11-16
- Decided by: Luan Tran (owner), from happy-clink's board; the owner chose milestones,
  a Gantt timeline and assigning from the board. Drafted by Claude.

## Context

The board shows features only by column. With many features the owner cannot see
which features belong to the same piece of product work, or when that work is due.
GitHub offers three ways to group issues: milestones, parent issues with sub-issues,
and labels. Only milestones carry a due date and open and closed counts, so only they
give a timeline something to draw without new fields.

## Decision

- A group is a GitHub milestone. A feature belongs to at most one group. Milestones are
  created, renamed and given due dates on GitHub; the board only reads them and assigns
  features to them.
- `loadBoard` returns each feature's `milestone` (`{ number, title, due }` or `null`),
  `created` and `closed`, and the repository's milestones (open and closed) with their
  counts. That costs one more request.
- The Board tab shows each card's milestone. A toggle, "Nhóm theo milestone", splits
  every column into one block per milestone, the nearest due date first and features
  without one last. The browser remembers the toggle.
- A Timeline tab draws a Gantt chart. `GET /api/timeline` loads every issue in a
  milestone, closed ones included, because the board keeps only the 20 latest closed
  features. `board/timeline.mjs` builds the rows, so the layout is tested in Node:
  - A milestone's bar runs from its earliest feature's creation (or the milestone's own
    creation when it has none) to its due date, filled by its closed share. Without a
    due date it runs to today and is marked open-ended. Past its due date with open
    features, it is overdue.
  - Expanding a milestone shows one bar per feature, from creation to closing (or
    today), coloured by its column. Features without a milestone get their own row,
    folded by default.
  - A line marks today; the axis is in weeks and scrolls sideways.
- A feature's bar starts when the issue was created, not when it started running: the
  issue list already has that date, while the start of running needs one events request
  per issue.
- The feature dialog has a milestone picker with the open milestones and "Không có".
  `POST /api/features/<n>/milestone` and the MCP tool `update_feature` (`milestone`: a
  number, or `null` to remove it) set it. `board_overview` lists the milestones.

## Consequences

- Projects group features without a new label or config key; a project that uses no
  milestones sees the same board as before, plus an empty timeline.
- Pull requests set on a milestone are left out of the timeline: only issues are
  features.
- The timeline is as good as the due dates on GitHub. Bars for features are approximate
  (creation, not start of work); an events-based start can come later if needed.
