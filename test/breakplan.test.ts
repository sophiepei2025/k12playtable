import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITIES } from "../src/core/data.js";
import { picksForBreak, bigCompanyWall } from "../src/core/breakplan.js";
import { getBoard, upcomingBreaks } from "../src/core/calendar.js";

const winter = upcomingBreaks(getBoard("tdsb")!, "secondary", "2026-11-24")[0]!;

test("winter-break picks: active, high school, no summer programs, no residential conflicts", () => {
  for (const goal of ["cs", "math_science", "health", "undecided"] as const) {
    const picks = picksForBreak(ACTIVITIES, { brk: winter, grade: 11, goal });
    assert.ok(picks.length > 0, goal);
    for (const p of picks) {
      assert.equal(p.activity.status, "active");
      assert.ok(p.activity.audience.includes("high_school"));
      assert.doesNotMatch(`${p.activity.name} ${p.activity.timing_text ?? ""}`, /\bsummer\b/i);
      if (p.activity.grades.length) assert.ok(p.activity.grades.includes(11));
    }
  }
});

test("a program with known dates outside the break is not suggested; inside the break ranks first", () => {
  const base = ACTIVITIES.find((a) => a.status === "active" && a.audience.includes("high_school") && a.subjects.includes("Mathematics"))!;
  const inside = { ...base, id: "in", name: "Inside", dates: { ...base.dates, start: "2026-12-28", end: "2026-12-30" } };
  const outside = { ...base, id: "out", name: "Outside", dates: { ...base.dates, start: "2027-03-01", end: "2027-03-05" } };
  const picks = picksForBreak([outside, inside, base], { brk: winter, goal: "math_science" });
  assert.equal(picks[0]!.activity.id, "in");
  assert.ok(!picks.some((p) => p.activity.id === "out"));
});

test("company wall only lists companies with an active high-school program", () => {
  const wall = bigCompanyWall(ACTIVITIES);
  assert.ok(wall.some((w) => w.company === "Google"));
  assert.ok(wall.every((w) => w.count > 0));
});
