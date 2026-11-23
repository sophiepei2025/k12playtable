import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConflicts, getDeadlines, toICS, PLANNING_DEFAULTS, type PlanItem } from "../src/core/planner.js";
import { planningRules, PLANNING_SKILL_MD } from "../src/core/planning-rules.js";

const today = "2026-11-23";

test("residential overlap is a conflict; backups are exempt", () => {
  const items: PlanItem[] = [
    { id: "shad", start: "2027-07-04", end: "2027-07-30", hours_per_week: 40, residential: true },
    { id: "camp", start: "2027-07-12", end: "2027-07-23", hours_per_week: 20, in_person: true },
    { id: "alt", start: "2027-07-05", end: "2027-07-20", hours_per_week: 20, in_person: true, role: "backup" },
  ];
  const { conflicts } = checkConflicts(items, { today });
  const overlap = conflicts.filter((c) => c.type === "overlap");
  assert.equal(overlap.length, 1);
  assert.deepEqual(overlap[0].items, ["shad", "camp"]);
});

test("travel buffer: back-to-back residential + in-person", () => {
  const { conflicts } = checkConflicts(
    [
      { id: "res", start: "2027-07-04", end: "2027-07-30", hours_per_week: 35, residential: true },
      { id: "next", start: "2027-07-31", end: "2027-08-10", hours_per_week: 10, in_person: true },
    ],
    { today },
  );
  assert.ok(conflicts.some((c) => c.type === "travel"));
});

test("weekly cap: term 10h vs summer 40h, grouped into one conflict", () => {
  const term = checkConflicts(
    [
      { id: "swim", start: "2027-01-04", end: "2027-03-28", hours_per_week: 6, role: "fixed" },
      { id: "robotics", start: "2027-01-11", end: "2027-02-28", hours_per_week: 6 },
    ],
    { today },
  );
  const over = term.conflicts.filter((c) => c.type === "overload");
  assert.equal(over.length, 1, "consecutive weeks collapse");
  assert.equal(over[0].cap, PLANNING_DEFAULTS.school_term_max_hours);
  assert.equal(over[0].hours, 12);
  const summer = checkConflicts([{ id: "camp", start: "2027-07-05", end: "2027-07-30", hours_per_week: 35 }], { today });
  assert.equal(summer.conflicts.filter((c) => c.type === "overload").length, 0);
  assert.ok(summer.weekly_load.every((w) => w.season === "summer" && w.cap === 40));
});

test("family override of caps", () => {
  const r = checkConflicts([{ id: "a", start: "2027-02-01", end: "2027-02-07", hours_per_week: 8 }], { today, config: { school_term_max_hours: 6 } });
  assert.ok(r.conflicts.some((c) => c.type === "overload" && c.cap === 6));
});

test("exam buffer, passed deadline and missing data", () => {
  const { conflicts } = checkConflicts(
    [
      { id: "late", start: "2027-06-01", end: "2027-06-20", hours_per_week: 5, app_deadline: "2026-10-01" },
      { id: "nodates", start: null, end: null, hours_per_week: null },
    ],
    { today, exams: [{ start: "2027-06-14", end: "2027-06-25", label: "June exams" }] },
  );
  const types = conflicts.map((c) => c.type);
  assert.ok(types.includes("exam"));
  assert.ok(types.includes("deadline_passed"));
  assert.equal(types.filter((t) => t === "missing_data").length, 2);
});

test("deadlines: prep lead time, reminders, sorted, past dropped, ICS", () => {
  const events = getDeadlines(
    [{ id: "shad", name: "Shad", start: "2027-07-04", end: "2027-07-30", hours_per_week: 40, app_deadline: "2027-01-06", needs_essay: true, needs_rec_letter: true }],
    { today },
  );
  const prep = events.find((e) => e.type === "prep_start")!;
  assert.equal(prep.date, "2026-12-09"); // 28 days before
  assert.deepEqual(events.filter((e) => e.type === "reminder").map((e) => e.date), ["2026-12-07", "2026-12-30", "2027-01-05"]);
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].date <= e.date), "sorted");
  assert.equal(getDeadlines([{ id: "old", start: null, end: null, hours_per_week: null, app_deadline: "2026-01-01" }], { today }).length, 0, "past dropped");
  const ics = toICS(events);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;VALUE=DATE:20270106/);
});

test("planning rules embed the confirmed defaults", () => {
  assert.match(PLANNING_SKILL_MD, /≤ 10 小时\/周/);
  assert.match(PLANNING_SKILL_MD, /≤ 40 小时\/周/);
  assert.deepEqual(planningRules().confirmed_by_owner, ["school_term_max_hours", "summer_max_hours", "exam_buffer_days"]);
});
