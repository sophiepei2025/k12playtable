import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARDS, boardsForCity, boardFromText, classifyDay, findBreaks, upcomingBreaks, getBoard, plansToICS, allCities,
} from "../src/core/calendar.js";

const tdsb = getBoard("tdsb")!;

test("12 boards, each with a source and both panels", () => {
  assert.equal(BOARDS.length, 12);
  for (const b of BOARDS) {
    assert.match(b.source, /^https:\/\//);
    assert.ok(b.pa.elementary.length && b.pa.secondary.length && b.last_day.elementary && b.last_day.secondary, b.id);
  }
});

test("city lookup returns the public and Catholic board", () => {
  assert.deepEqual(boardsForCity("Markham").map((b) => b.short), ["YRDSB", "YCDSB"]);
  assert.deepEqual(boardsForCity("mississauga", "catholic").map((b) => b.short), ["DPCDSB"]);
  assert.equal(boardsForCity("Ottawa").length, 0);
  assert.ok(allCities().includes("Toronto"));
  assert.equal(boardFromText("tdsb")?.id, "tdsb");
  assert.equal(boardFromText("York Catholic")?.id, "ycdsb");
});

test("day classification", () => {
  assert.equal(classifyDay("2026-11-20", tdsb, "elementary").kind, "pa");
  assert.equal(classifyDay("2026-11-19", tdsb, "elementary").kind, "school");
  assert.equal(classifyDay("2027-02-15", tdsb, "elementary").label, "Family Day");
  assert.equal(classifyDay("2026-12-23", tdsb, "elementary").label, "Winter Break");
  assert.equal(classifyDay("2027-06-30", tdsb, "elementary").kind, "summer");
  assert.equal(classifyDay("2027-06-29", tdsb, "secondary").kind, "summer");
});

test("TDSB elementary: PA Friday makes a long weekend; Family Day + PA Friday = 4 days", () => {
  const b = findBreaks(tdsb, "elementary", "2026-11-01", "2027-02-28");
  const nov = b.find((x) => x.start === "2026-11-20")!;
  assert.equal(nov.kind, "long_weekend");
  assert.equal(nov.days, 3);
  const feb = b.find((x) => x.reasons.includes("Family Day"))!;
  assert.deepEqual([feb.start, feb.end, feb.days], ["2027-02-12", "2027-02-15", 4]);
  const winter = b.find((x) => x.name === "Winter Break")!;
  assert.deepEqual([winter.start, winter.end, winter.days], ["2026-12-19", "2027-01-03", 16]);
});

test("Easter: Good Friday + Easter Monday = 4-day long weekend", () => {
  const b = findBreaks(tdsb, "secondary", "2027-03-20", "2027-04-05");
  const easter = b.find((x) => x.reasons.includes("Good Friday"))!;
  assert.deepEqual([easter.start, easter.end, easter.days, easter.kind], ["2027-03-26", "2027-03-29", 4, "long_weekend"]);
});

test("panels differ: secondary summer starts earlier", () => {
  const el = upcomingBreaks(tdsb, "elementary", "2027-06-01").find((x) => x.name === "Summer")!;
  const se = upcomingBreaks(tdsb, "secondary", "2027-06-01").find((x) => x.name === "Summer")!;
  assert.equal(el.start, "2027-06-30");
  assert.equal(se.start, "2027-06-29");
});

test("estimated last day flags the summer break", () => {
  const ycdsb = getBoard("ycdsb")!;
  const s = upcomingBreaks(ycdsb, "elementary", "2027-06-01").find((x) => x.name === "Summer")!;
  assert.equal(s.estimated, true);
  assert.equal(upcomingBreaks(tdsb, "elementary", "2027-06-01").find((x) => x.name === "Summer")!.estimated, false);
});

test("upcoming breaks start from today", () => {
  const u = upcomingBreaks(tdsb, "elementary", "2026-11-24", 3);
  assert.equal(u[0]!.name, "Winter Break");
  assert.ok(u.every((x) => x.end >= "2026-11-24"));
});

test("ics export uses exclusive end dates", () => {
  const ics = plansToICS([{ id: "a", title: "Robotics camp, week 1", start: "2026-12-21", end: "2026-12-24" }]);
  assert.match(ics, /DTSTART;VALUE=DATE:20261221/);
  assert.match(ics, /DTEND;VALUE=DATE:20261225/);
  assert.match(ics, /SUMMARY:Robotics camp\\, week 1/);
});
