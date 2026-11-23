import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivitySchema, type Activity } from "../src/core/schema.js";
import { activityLogistics, weeklyTravel, haversineKm, estimateCommuteMinutes, coordsFor } from "../src/core/logistics.js";
import { search } from "../src/core/search.js";
import { checkConflicts } from "../src/core/planner.js";

const act = (over: Partial<Activity> & { id: string }): Activity =>
  ActivitySchema.parse({ name: over.id, description: "x", link: "https://e.org", category: "Program", audience: ["high_school"], region: { country: "CA" }, organizer: { type: "nonprofit" }, ...over });

test("distance + commute estimate: Markham → Toronto is close, Markham → Waterloo is long", () => {
  const km = haversineKm(coordsFor("markham")!, coordsFor("toronto")!);
  assert.ok(km > 20 && km < 30, `km=${km}`);
  const m = estimateCommuteMinutes(km);
  assert.ok(m >= 40 && m <= 60, `markham→toronto ${m} min`);
  const wkm = haversineKm(coordsFor("markham")!, coordsFor("waterloo")!);
  const wm = estimateCommuteMinutes(wkm);
  assert.ok(wm >= 90 && wm <= 150, `markham→waterloo ${wm} min`);
  const wl = activityLogistics(act({ id: "w", environment: "in_person", region: { country: "CA", city: "Waterloo" } as Activity["region"] }), { home_city: "Markham" });
  assert.equal(wl.band, "high");
  assert.ok(wl.estimated);
});

test("bands: online none, residential travel, far = travel, unknown without location, hybrid one band easier", () => {
  assert.equal(activityLogistics(act({ id: "o", environment: "online" })).band, "none");
  assert.equal(activityLogistics(act({ id: "r", environment: "in_person", residential: true })).band, "travel");
  assert.equal(activityLogistics(act({ id: "b", environment: "in_person", region: { country: "US", city: "Boston" } as Activity["region"] }), { home_city: "Toronto" }).band, "travel");
  assert.equal(activityLogistics(act({ id: "u", environment: "in_person" }), { home_city: "Toronto" }).band, "unknown");
  assert.equal(activityLogistics(act({ id: "n", environment: "in_person", region: { country: "CA", city: "Toronto" } as Activity["region"] })).band, "unknown", "no home → unknown");
  const hyb = activityLogistics(act({ id: "h", environment: "hybrid", region: { country: "CA", city: "Waterloo" } as Activity["region"] }), { home_city: "Markham" });
  assert.equal(hyb.band, "medium");
});

test("parent time = cheaper of 4 one-way legs vs 2 legs + waiting", () => {
  // 40 min each way, 2×/week, 1.5 h session: min(160, 80+90)=160 min ×2 = 5.3 h
  assert.deepEqual(weeklyTravel({ commute_minutes_one_way: 40, sessions_per_week: 2, session_hours: 1.5, hours_per_week: 3 }), { student_commute_hours: 2.7, parent_hours: 5.3, sessions: 2, missing: [] });
  // 30 min each way, 1×/week, 0.5 h session: min(120, 60+30)=90 → 1.5 h
  assert.equal(weeklyTravel({ commute_minutes_one_way: 30, sessions_per_week: 1, session_hours: 0.5, hours_per_week: 0.5 }).parent_hours, 1.5);
  assert.equal(weeklyTravel({ commute_minutes_one_way: 30, sessions_per_week: 1, hours_per_week: 2 }, "transit").parent_hours, 0);
  assert.equal(weeklyTravel({ online: true, hours_per_week: 5 }).parent_hours, 0);
  assert.deepEqual(weeklyTravel({ hours_per_week: 2 }).missing, ["commute_minutes_one_way", "sessions_per_week"]);
});

test("search: convenience sort puts online/close first; signal sort keeps tier first", () => {
  const home = { country: "CA", city: "Toronto" } as Activity["region"];
  const far = { country: "CA", city: "Ottawa" } as Activity["region"];
  const list = [
    act({ id: "far_free_sel", environment: "in_person", region: far, fee_type: "free", selectivity: "selective" }),
    act({ id: "near_paid_open", environment: "in_person", region: home, fee_type: "paid", selectivity: "open" }),
    act({ id: "online_paid_open", environment: "online", fee_type: "paid", selectivity: "open" }),
  ];
  assert.deepEqual(search(list, { home_city: "North York", sort: "convenience" }).results.map((r) => r.id), ["online_paid_open", "near_paid_open", "far_free_sel"]);
  assert.deepEqual(search(list, { home_city: "North York" }).results.map((r) => r.id), ["far_free_sel", "online_paid_open", "near_paid_open"]);
  assert.deepEqual(search(list, { home_city: "North York", max_commute_minutes: 60 }).results.map((r) => r.id).sort(), ["near_paid_open", "online_paid_open"]);
  const r = search(list, { home_city: "North York" }).results.find((x) => x.id === "near_paid_open")!;
  assert.equal(r.logistics, "medium");
  assert.ok(r.est_commute_minutes! > 20);
});

test("planner: commute counts toward S1, S7 commute limit, S8 parent time", () => {
  const { conflicts, weekly_load } = checkConflicts(
    [
      { id: "robotics", start: "2027-01-11", end: "2027-02-28", hours_per_week: 3, sessions_per_week: 2, session_hours: 1.5, commute_minutes_one_way: 40 },
      { id: "debate", start: "2027-01-11", end: "2027-02-28", hours_per_week: 5, online: true },
      { id: "far", start: "2027-01-11", end: "2027-01-17", hours_per_week: 1, sessions_per_week: 1, commute_minutes_one_way: 70 },
    ],
    { today: "2026-11-23" },
  );
  const w = weekly_load[0];
  assert.equal(w.commute_hours, 5); // 2.7 + 2.3
  assert.equal(w.parent_hours, 8.6); // 5.3 + min(4×70, 2×70+60)=200 min → 3.3
  const types = conflicts.map((c) => c.type);
  assert.ok(types.includes("commute"));
  assert.ok(types.includes("parent_time"));
  assert.ok(types.includes("overload"), "8 h activity + commute > 10 h");
  const transit = checkConflicts([{ id: "robotics", start: "2027-01-11", end: "2027-02-28", hours_per_week: 3, sessions_per_week: 2, session_hours: 1.5, commute_minutes_one_way: 40 }], { today: "2026-11-23", family: { transport: "transit" } });
  assert.ok(!transit.conflicts.some((c) => c.type === "parent_time"));
});
