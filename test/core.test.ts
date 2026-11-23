import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITIES } from "../src/core/data.js";
import { ActivitySchema, type Activity } from "../src/core/schema.js";
import { search, compare, getById, tokenize } from "../src/core/search.js";
import { explainSignals, tierOf, decisionCompleteness, formatCost } from "../src/core/signals.js";
import { normalizeRaw, applyPatch } from "../scripts/build-data.js";

const base = (over: Partial<Activity> = {}): Activity =>
  ActivitySchema.parse({
    id: "x", name: "Test Program", description: "A robotics program", link: "https://example.org",
    category: "Program", audience: ["high_school"], region: { country: "US" }, organizer: { type: "nonprofit" }, ...over,
  });

test("dataset: every record passes the schema and ids are unique", () => {
  assert.ok(ACTIVITIES.length >= 333);
  for (const a of ACTIVITIES) ActivitySchema.parse(a);
  assert.equal(new Set(ACTIVITIES.map((a) => a.id)).size, ACTIVITIES.length);
});

test("dataset: typo fixed, discontinued marked, university-only kept with audience", () => {
  assert.ok(!ACTIVITIES.some((a) => a.category === "Comnpetition"));
  assert.equal(getById(ACTIVITIES, "google_codein")?.status, "discontinued");
  assert.ok(ACTIVITIES.some((a) => !a.audience.includes("high_school")), "undergrad/grad entries kept");
  const shad = getById(ACTIVITIES, "shad-canada")!;
  assert.equal(shad.region.country, "CA");
  assert.equal(shad.dates.app_deadline, "2027-01-06");
  assert.deepEqual(shad.grades, [10, 11]);
  assert.ok(shad.last_verified);
});

test("normalizeRaw maps raw fields", () => {
  const a = normalizeRaw({
    id: "r1", name: " Waterloo Contest ", description: "d", link: "https://x.ca", type: "Academic Program",
    category: ["Comnpetition"], grade: ["11th Grade", "Undergraduate"], location: ["Global Worldwide"],
    environment: "Remote/Virtual", commitment: "Long-Term", soloTeam: "Individual-Based", src: "data:image/png;base64,AAA",
  });
  assert.equal(a.name, "Waterloo Contest");
  assert.equal(a.category, "Competition");
  assert.deepEqual(a.audience.sort(), ["high_school", "undergraduate"]);
  assert.deepEqual(a.grades, [11]);
  assert.equal(a.region.country, "CA");
  assert.equal(a.environment, "online");
  assert.equal(a.organizer.type, "university_program");
  assert.equal(a.logo, null, "base64 logos dropped");
});

test("applyPatch deep-merges objects and replaces arrays", () => {
  const out = applyPatch({ dates: { a: 1, b: 2 }, list: [1, 2] } as Record<string, unknown>, { dates: { b: 3 }, list: [9] });
  assert.deepEqual(out, { dates: { a: 1, b: 3 }, list: [9] });
});

test("search: keyword relevance, filters and discontinued hidden by default", () => {
  const r = search(ACTIVITIES, { q: "robotics", limit: 5 });
  assert.ok(r.total > 0);
  assert.match(r.results[0].name.toLowerCase(), /robot/);
  assert.ok(!search(ACTIVITIES, { q: "code-in" }).results.some((x) => x.id === "google_codein"));
  assert.ok(search(ACTIVITIES, { q: "code-in", include_discontinued: true }).results.some((x) => x.id === "google_codein"));
  const ca = search(ACTIVITIES, { country: ["CA"], limit: 50 });
  assert.ok(ca.results.every((x) => x.country === "CA"));
  const hs = search(ACTIVITIES, { audience: ["high_school"], grade: 12, limit: 200 });
  assert.ok(hs.results.every((x) => x.audience.includes("high_school") && (x.grades.length === 0 || x.grades.includes(12))));
});

test("search: verified fee/cost filters never match unknown data", () => {
  const list = [base({ id: "free1", fee_type: "free", selectivity: "selective" }), base({ id: "unk" }), base({ id: "paid", cost: { min: 500, max: 900, currency: "USD", includes: [] } })];
  assert.deepEqual(search(list, { fee: "free" }).results.map((r) => r.id), ["free1"]);
  assert.deepEqual(search(list, { max_cost: 600 }).results.map((r) => r.id).sort(), ["free1", "paid"]);
  assert.deepEqual(search(list, { max_cost: 100 }).results.map((r) => r.id), ["free1"]);
});

test("search: default sort puts free + selective first", () => {
  const list = [
    base({ id: "paid_open", fee_type: "paid", selectivity: "open" }),
    base({ id: "unknown" }),
    base({ id: "free_sel", fee_type: "free", selectivity: "highly_selective" }),
    base({ id: "paid_sel", fee_type: "paid", selectivity: "selective" }),
  ];
  assert.deepEqual(search(list).results.map((r) => r.id), ["free_sel", "paid_sel", "paid_open", "unknown"]);
});

test("tokenize keeps CJK and symbols like C++", () => {
  assert.deepEqual(tokenize("C++ 机器人 AI"), ["c++", "机器人", "ai"]);
});

test("signals: tier, completeness, cost format, caveats", () => {
  const a = base({ fee_type: "free", selectivity: "selective", organizer: { type: "company", is_big_company: true, name: null } });
  assert.equal(tierOf(a), "free_selective");
  assert.equal(formatCost(base({ cost: { min: 7495, max: 7495, currency: "CAD", includes: [] } })), "C$7,495");
  const c = decisionCompleteness(a);
  assert.equal(c.filled, 2);
  const s = explainSignals(base({ audience: ["undergraduate"], red_flags: ["pay_to_publish"] }));
  assert.ok(s.caveats.some((x) => /not high school/.test(x)));
  assert.ok(s.caveats.some((x) => /Pay-to-publish/.test(x)));
  assert.ok(s.caveats.some((x) => /not verified/.test(x)));
  assert.match(explainSignals(base({ organizer: { type: "company", is_big_company: true, name: null } })).organizer_note, /big brand/i);
});

test("compare: rows aligned, unknown shown, missing ids reported", () => {
  const c = compare(ACTIVITIES, ["shad-canada", "waterloo-cemc-contests", "nope"]);
  assert.equal(c.activities.length, 2);
  assert.deepEqual(c.missing_ids, ["nope"]);
  for (const r of c.rows) assert.equal(r.values.length, 2);
  assert.equal(c.rows.find((r) => r.label === "Application deadline")!.values[0], "2027-01-06");
});
